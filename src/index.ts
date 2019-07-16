import { join } from "path";
import * as Octokit from "@octokit/rest";
import { Spectral } from "@stoplight/spectral";
import { EOL } from "os";
import { promises as fs } from "fs";
import { Config } from "./config";
import { OasDocument } from "./oasDocument";
import {
  oas2Functions,
  rules as oas2Rules
} from "@stoplight/spectral/dist/rulesets/oas2";
import {
  oas3Functions,
  rules as oas3Rules
} from "@stoplight/spectral/dist/rulesets/oas3";
import { DiagnosticSeverity } from "@stoplight/types";
import * as IOEither from "fp-ts/lib/IOEither";
import * as IO from "fp-ts/lib/IO";
import * as TaskEither from "fp-ts/lib/TaskEither";
import * as Either from "fp-ts/lib/Either";
import { error, log } from "fp-ts/lib/Console";
import { failure } from "io-ts/lib/PathReporter";
import { pipe } from "fp-ts/lib/pipeable";

type Event = {
  repository: {
    name: string;
    owner: {
      login: string;
    };
  };
};

const createSpectral = async (doc: "oas2" | "oas3") => {
  const spectral = new Spectral();
  if (doc === "oas2") {
    spectral.addFunctions(oas2Functions());
    spectral.addRules(await oas2Rules());
  } else {
    spectral.addFunctions(oas3Functions());
    spectral.addRules(await oas3Rules());
  }

  return spectral;
};

const createSpectralAnnotations = (path: string, parsed: OasDocument) =>
  pipe(
    TaskEither.tryCatch(
      () => createSpectral(parsed.swagger ? "oas2" : "oas3"),
      e => Either.toError(e).message
    ),
    TaskEither.chain(spectral =>
      TaskEither.tryCatch(
        () => spectral.run(parsed),
        e => Either.toError(e).message
      )
    ),
    TaskEither.map(results =>
      results.map<Octokit.ChecksUpdateParamsOutputAnnotations>(
        validationResult => {
          const annotation_level: Octokit.ChecksUpdateParamsOutputAnnotations["annotation_level"] =
            validationResult.severity === DiagnosticSeverity.Error
              ? "failure"
              : validationResult.severity === DiagnosticSeverity.Warning
              ? "warning"
              : "notice";

          const sameLine =
            validationResult.range.start.line ===
            validationResult.range.end.line;

          return {
            annotation_level,
            message: validationResult.message,
            title: validationResult.code as string,
            start_line: 1 + validationResult.range.start.line,
            end_line: 1 + validationResult.range.end.line,
            start_column: sameLine
              ? validationResult.range.start.character
              : undefined,
            end_column: sameLine
              ? validationResult.range.end.character
              : undefined,
            path
          };
        }
      )
    )
  );

const createOctokitInstance = (token: string) =>
  TaskEither.fromIOEither(
    IOEither.tryCatch(
      () => new Octokit({ auth: `token ${token}` }),
      e => Either.toError(e).message
    )
  );

const createGithubCheck = (
  octokit: Octokit,
  event: { owner: string; repo: string },
  name: string,
  head_sha: string
) =>
  TaskEither.tryCatch(
    () =>
      octokit.checks.create({
        owner: event.owner,
        repo: event.repo,
        name,
        head_sha
      }),
    e => Either.toError(e).message
  );

const readFileToAnalyze = (path: string) =>
  pipe(
    TaskEither.tryCatch(
      () => fs.readFile(path, { encoding: "utf8" }),
      e => Either.toError(e).message
    ),
    TaskEither.chain(content =>
      TaskEither.fromEither(
        Either.parseJSON(content, e => Either.toError(e).message)
      )
    ),
    TaskEither.chain(content =>
      TaskEither.fromEither(
        pipe(
          OasDocument.decode(content),
          Either.mapLeft(e => failure(e).join(EOL))
        )
      )
    )
  );

const getRepositoryInfoFromEvent = (eventPath: string) =>
  pipe(
    TaskEither.fromIOEither(
      IOEither.tryCatch<string, Event>(
        () => require(eventPath),
        e => Either.toError(e).message
      )
    ),
    TaskEither.map(event => {
      const { repository } = event;
      const {
        owner: { login: owner }
      } = repository;
      const { name: repo } = repository;
      return { owner, repo };
    })
  );

const updateGithubCheck = (
  octokit: Octokit,
  actionName: string,
  check: Octokit.Response<Octokit.ChecksCreateResponse>,
  event: { owner: string; repo: string },
  annotations: Octokit.ChecksUpdateParamsOutputAnnotations[],
  conclusion: Octokit.ChecksUpdateParams["conclusion"],
  message?: string
) =>
  TaskEither.tryCatch(
    () =>
      octokit.checks.update({
        check_run_id: check.data.id,
        owner: event.owner,
        name: actionName,
        repo: event.repo,
        status: "completed",
        conclusion,
        completed_at: new Date().toISOString(),
        output: {
          title: actionName,
          summary: message
            ? message
            : conclusion === "success"
            ? "Lint completed successfully"
            : "Lint completed with some errors",
          annotations
        }
      }),
    e => Either.toError(e).message
  );

const getEnv = IO.of(process.env);

const decodeConfig = (env: NodeJS.ProcessEnv) =>
  pipe(
    Config.decode(env),
    Either.mapLeft(e => failure(e).join(EOL))
  );

const createConfigFromEnv = pipe(
  IOEither.ioEither.fromIO<string, NodeJS.ProcessEnv>(getEnv),
  IOEither.chain(env => IOEither.fromEither(decodeConfig(env)))
);

const program = pipe(
  TaskEither.fromIOEither(createConfigFromEnv),
  TaskEither.chain(
    ({
      GITHUB_EVENT_PATH,
      GITHUB_TOKEN,
      GITHUB_SHA,
      GITHUB_WORKSPACE,
      GITHUB_ACTION,
      SPECTRAL_FILE_PATH
    }) => {
      return pipe(
        getRepositoryInfoFromEvent(GITHUB_EVENT_PATH),
        TaskEither.chain(event =>
          pipe(
            createOctokitInstance(GITHUB_TOKEN),
            TaskEither.map(octokit => ({ octokit, event }))
          )
        ),
        TaskEither.chain(({ octokit, event }) =>
          pipe(
            createGithubCheck(octokit, event, GITHUB_ACTION, GITHUB_SHA),
            TaskEither.map(check => ({ octokit, event, check }))
          )
        ),
        TaskEither.chain(({ octokit, event, check }) =>
          pipe(
            readFileToAnalyze(join(GITHUB_WORKSPACE, SPECTRAL_FILE_PATH)),
            TaskEither.chain(content =>
              createSpectralAnnotations(SPECTRAL_FILE_PATH, content)
            ),
            TaskEither.chain(annotations =>
              updateGithubCheck(
                octokit,
                GITHUB_ACTION,
                check,
                event,
                annotations,
                annotations.findIndex(f => f.annotation_level === "failure") ===
                  -1
                  ? "success"
                  : "failure"
              )
            ),
            TaskEither.orElse(e =>
              updateGithubCheck(
                octokit,
                GITHUB_ACTION,
                check,
                event,
                [],
                "failure",
                Either.toError(e).message
              )
            )
          )
        )
      );
    }
  )
);

program().then(result =>
  pipe(
    result,
    Either.fold(error, () => log("Worked fine"))
  )
);
