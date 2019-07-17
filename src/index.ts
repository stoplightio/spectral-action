import { join } from "path";
import { DiagnosticSeverity } from "@stoplight/types";
import * as Octokit from "@octokit/rest";
import { EOL } from "os";
import { promises as fs } from "fs";

import { Config } from "./config";
import { OasDocument } from "./oasDocument";
import { runSpectral, createSpectral } from "./spectral";
import {
  createGithubCheck,
  createOctokitInstance,
  getRepositoryInfoFromEvent,
  updateGithubCheck
} from "./octokit";

import * as IOEither from "fp-ts/lib/IOEither";
import * as IO from "fp-ts/lib/IO";
import * as TaskEither from "fp-ts/lib/TaskEither";
import * as Either from "fp-ts/lib/Either";
import { error, log } from "fp-ts/lib/Console";
import { failure } from "io-ts/lib/PathReporter";
import { pipe } from "fp-ts/lib/pipeable";

const createSpectralAnnotations = (path: string, parsed: OasDocument) =>
  pipe(
    createSpectral(parsed.swagger ? "oas2" : "oas3"),
    TaskEither.chain(spectral => runSpectral(spectral, parsed)),
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
      ).sort((a, b)=> a.start_line > b.start_line)
    )
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
