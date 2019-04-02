import { join } from "path";
import * as Octokit from "@octokit/rest";
import { Spectral } from "@stoplight/spectral";
import { readFileSync } from "fs";
import { oas2Functions, oas2Rules } from "@stoplight/spectral/rulesets/oas2";
import { oas3Functions, oas3Rules } from "@stoplight/spectral/rulesets/oas3";
import { DiagnosticSeverity } from "@stoplight/types";
import { IOEither, tryCatch2v } from "fp-ts/lib/IOEither";
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

const getEnv: IO<NodeJS.ProcessEnv> = new IO(() => process.env);
const getConfig: IO<Either<t.Errors, Config>> = getEnv.map(env => Config.decode(env));
const createConfigFromEnv = fromIOEither(new IOEither(getConfig));

const program = createConfigFromEnv
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

    const parseJSON = (fileContent: string) => tryCatch2v(() => JSON.parse(fileContent), e => String(e));

    const runSpectralWith = (parsed: object) => tryCatch(
      () => createSpectral().run(parsed),
      e => String(e)
    );

    const createGithubCheck = (octokit: Octokit, event: { owner: string, repo: string }) => tryCatch(
      () => octokit.checks.create({
        owner: event.owner,
        repo: event.repo,
        name: "Spectral Lint Check",
        head_sha: GITHUB_SHA
      }),
      e => String(e)
    );

    const updateGithuCheck = (octokit: Octokit, check: Octokit.Response<Octokit.ChecksCreateResponse>, event: { owner: string, repo: string }, annotations: Octokit.ChecksUpdateParamsOutputAnnotations[]) => tryCatch(
      () => octokit.checks.update({
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

    return getRepositoryInfoFromEvent
      .chain(event => createOctokitInstance.map(octokit => ({ octokit, event })))
      .chain(({ octokit, event }) => {
        return createGithubCheck(octokit, event).chain(check =>
          fromIOEither(readFileToAnalyze
            .chain(parseJSON))
            .chain(runSpectralWith)
            .chain(results => {

              const annotations: Octokit.ChecksUpdateParamsOutputAnnotations[] = results.map(validationResult => {

                const annotation_level: "notice" | "warning" | "failure" =
                  validationResult.severity === DiagnosticSeverity.Error
                    ? "failure"
                    : validationResult.severity === DiagnosticSeverity.Warning
                      ? "warning"
                      : "notice";

                return {
                  annotation_level,
                  message: validationResult.message,
                  title: validationResult.summary,
                  start_line: validationResult.range.start.line,
                  end_line: validationResult.range.end.line,
                  start_column: validationResult.range.start.character,
                  end_column: validationResult.range.end.character,
                  path: SPECTRAL_FILE_PATH
                };
              });

              return updateGithuCheck(octokit, check, event, annotations);
            })
        );
      });
  });

program
  .run()
  .then(result => result.fold(error, () => log("Worked fine")));
