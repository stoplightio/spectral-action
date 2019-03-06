import { join } from "path";
import * as Octokit from "@octokit/rest";
import { Spectral } from "@stoplight/spectral";
import { pathToPointer } from "@stoplight/json";
import { parseWithPointers } from "@stoplight/json/parseWithPointers";
import { readFileSync } from "fs";
import { oas2Functions, oas2Rules } from "@stoplight/spectral/rulesets/oas2";
import { oas3Functions, oas3Rules } from "@stoplight/spectral/rulesets/oas3";
import { ValidationSeverity } from "@stoplight/types/validations";
import { IPathPosition, IParserResult } from "@stoplight/types/parsers";
import { IOEither, tryCatch2v } from "fp-ts/lib/IOEither";
import { fromNullable } from "fp-ts/lib/Option";
import { IO } from "fp-ts/lib/IO";
import { fromIOEither, tryCatch } from "fp-ts/lib/TaskEither";
import { Either } from "fp-ts/lib/Either";
import { failure } from "io-ts/lib/PathReporter";
import * as t from "io-ts";
import { error, log } from "console";

const Config = t.strict({
  GITHUB_EVENT_PATH: t.string,
  GITHUB_TOKEN: t.string,
  GITHUB_SHA: t.string,
  GITHUB_WORKSPACE: t.string,
  SPECTRAL_FILE_PATH: t.string
});

type Config = t.TypeOf<typeof Config>;

type Event = {
  repository: {
    name: string;
    owner: {
      login: string;
    };
  };
};

const createSpectral = () => {
  const spectral = new Spectral();
  spectral.addFunctions(oas2Functions());
  spectral.addRules(oas2Rules());
  spectral.addFunctions(oas3Functions());
  spectral.addRules(oas3Rules());

  return spectral;
};

function isDefined(t: IPathPosition): t is Required<IPathPosition> {
  return !!t.end;
}
const getEnv: IO<NodeJS.ProcessEnv> = new IO(() => process.env);
const getConfig: IO<Either<t.Errors, Config>> = getEnv.map(env => Config.decode(env));
const createConfigFromEnv = fromIOEither(new IOEither(getConfig));

createConfigFromEnv
  .mapLeft(errors => failure(errors).join("\n"))
  .chain(({ GITHUB_EVENT_PATH, GITHUB_TOKEN, GITHUB_SHA, GITHUB_WORKSPACE, SPECTRAL_FILE_PATH }) => {
    const getRepositoryInfoFromEvent = fromIOEither(
      tryCatch2v<string, Event>(() => require(GITHUB_EVENT_PATH), e => String(e))
    ).map(event => {
      const { repository } = event;
      const {
        owner: { login: owner }
      } = repository;
      const { name: repo } = repository;
      return { owner, repo };
    });

    const createOctokitInstance = fromIOEither(
      tryCatch2v(() => new Octokit({ auth: `token ${GITHUB_TOKEN}` }), e => String(e))
    );

    const readFileToAnalyze = tryCatch2v(
      () => readFileSync(join(GITHUB_WORKSPACE, SPECTRAL_FILE_PATH), { encoding: "utf8" }),
      e => String(e)
    );

    const parseJsonWithPointers = (fileContent: string) =>
      tryCatch2v(() => parseWithPointers(fileContent), e => String(e));

    const runSpectralWith = (parsed: IParserResult<any>) =>
      tryCatch2v(
        () => ({ parsed, results: createSpectral().run(parsed.data, { resolvedTarget: parsed.data }).results }),
        e => String(e)
      );

    return getRepositoryInfoFromEvent
      .chain(event => createOctokitInstance.map(octokit => ({ event, octokit })))
      .chain(({ event, octokit }) => {
        return tryCatch(
          () =>
            octokit.checks.create({
              owner: event.owner,
              repo: event.repo,
              name: "Spectral Lint Check",
              head_sha: GITHUB_SHA
            }),
          e => String(e)
        ).chain(check =>
          fromIOEither(readFileToAnalyze
            .chain(parseJsonWithPointers)
            .chain(runSpectralWith))
            .chain(({ parsed, results }) => {
              const defaultAnnotation: Required<IPathPosition> = {
                start: { line: 0, column: undefined },
                end: { line: 0, column: undefined }
              };

              const annotations: Octokit.ChecksUpdateParamsOutputAnnotations[] = results.map(validationResult => {
                const path = pathToPointer(validationResult.path as string[]).slice(1);
                const position = fromNullable(parsed.pointers[path])
                  .filter(isDefined)
                  .map(pointer => ({ ...defaultAnnotation, ...pointer }))
                  .getOrElse(defaultAnnotation);

                const annotation_level: "notice" | "warning" | "failure" =
                  validationResult.severity === ValidationSeverity.Error
                    ? "failure"
                    : validationResult.severity === ValidationSeverity.Warn
                      ? "warning"
                      : "notice";

                return {
                  annotation_level,
                  message: validationResult.summary,
                  title: validationResult.name,
                  start_line: position.start.line,
                  end_line: position.end.line,
                  start_column: position.start.column,
                  end_column: position.end.column,
                  path: SPECTRAL_FILE_PATH
                };
              });

              return tryCatch(
                () =>
                  octokit.checks.update({
                    check_run_id: check.data.id,
                    owner: event.owner,
                    name: "Spectral Lint Check",
                    repo: event.repo,
                    status: "completed",
                    conclusion: "failure",
                    completed_at: new Date().toISOString(),
                    output: {
                      title: "Spectral Lint Check",
                      summary: "This was horrible",
                      annotations
                    }
                  }),
                e => String(e)
              );
            }
            )
        );
      });
  })
  .run()
  .then(result => result.fold(error, () => log("Worked fine")));
