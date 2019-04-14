import { join } from 'path';
import * as Octokit from '@octokit/rest';
import { Spectral } from '@stoplight/spectral';
import { readFileSync } from 'fs';
import { oas2Functions, oas2Rules } from '@stoplight/spectral/rulesets/oas2';
import { oas3Functions, oas3Rules } from '@stoplight/spectral/rulesets/oas3';
import { DiagnosticSeverity } from '@stoplight/types';
import { IOEither, tryCatch2v } from 'fp-ts/lib/IOEither';
import { IO } from 'fp-ts/lib/IO';
import * as TaskEither from 'fp-ts/lib/TaskEither';
import { Either, parseJSON } from 'fp-ts/lib/Either';
import * as t from 'io-ts';
import { error, log } from 'fp-ts/lib/Console';

const oasDocument = t.partial({
  swagger: t.string,
  openapi: t.string
})

type oasDocument = t.TypeOf<typeof oasDocument>;

const Config = t.strict({
  GITHUB_EVENT_PATH: t.string,
  GITHUB_TOKEN: t.string,
  GITHUB_SHA: t.string,
  GITHUB_WORKSPACE: t.string,
  SPECTRAL_FILE_PATH: t.string,
  GITHUB_ACTION: t.string
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

const createSpectral = (doc: 'oas2' | 'oas3') => {
  const spectral = new Spectral();
  if (doc === 'oas2') {
    spectral.addFunctions(oas2Functions());
    spectral.addRules(oas2Rules());
  } else {
    spectral.addFunctions(oas3Functions());
    spectral.addRules(oas3Rules());
  }

  return spectral;
};

const runSpectral = (parsed: oasDocument) =>
  TaskEither.tryCatch(() => createSpectral(parsed.swagger ? 'oas2' : 'oas3').run(parsed), e => e);

const createOctokitInstance = (token: string) =>
  TaskEither.fromIOEither(tryCatch2v(() => new Octokit({ auth: `token ${token}` }), e => Object(e)));

const createGithubCheck = (octokit: Octokit, event: { owner: string; repo: string }, name: string, head_sha: string) =>
  TaskEither.tryCatch(
    () =>
      octokit.checks.create({
        owner: event.owner,
        repo: event.repo,
        name,
        head_sha
      }),
    e => Object(e)
  );

const readFileToAnalyze = (path: string) => TaskEither.fromIOEither(tryCatch2v(() => readFileSync(path, { encoding: 'utf8' }), e => e));

const getRepositoryInfoFromEvent = (eventPath: string) => TaskEither.fromIOEither(
  tryCatch2v<object, Event>(() => require(eventPath), e => Object(e))
).map(event => {
  const { repository } = event;
  const {
    owner: { login: owner }
  } = repository;
  const { name: repo } = repository;
  return { owner, repo };
});

const getEnv: IO<NodeJS.ProcessEnv> = new IO(() => process.env);
const getConfig: IO<Either<t.Errors, Config>> = getEnv.map(env => Config.decode(env));
const createConfigFromEnv = TaskEither.fromIOEither(new IOEither(getConfig));

const program = createConfigFromEnv
  .mapLeft(errors => Object(errors))
  .chain(({ GITHUB_EVENT_PATH, GITHUB_TOKEN, GITHUB_SHA, GITHUB_WORKSPACE, GITHUB_ACTION, SPECTRAL_FILE_PATH }) => {

    const updateGithubCheck = (
      octokit: Octokit,
      check: Octokit.Response<Octokit.ChecksCreateResponse>,
      event: { owner: string; repo: string },
      annotations: Octokit.ChecksUpdateParamsOutputAnnotations[],
      conclusion: Octokit.ChecksUpdateParams['conclusion'],
      message?: string
    ) =>
      TaskEither.tryCatch(
        () =>
          octokit.checks.update({
            check_run_id: check.data.id,
            owner: event.owner,
            name: GITHUB_ACTION,
            repo: event.repo,
            status: 'completed',
            conclusion,
            completed_at: new Date().toISOString(),
            output: {
              title: GITHUB_ACTION,
              summary: message
                ? message
                : conclusion === 'success'
                  ? 'Lint completed successfully'
                  : 'Lint completed with some errors',
              annotations
            }
          }),
        e => Object(e)
      );

    return getRepositoryInfoFromEvent(GITHUB_EVENT_PATH)
      .chain(event => createOctokitInstance(GITHUB_TOKEN).map(octokit => ({ octokit, event })))
      .chain(({ octokit, event }) =>
        createGithubCheck(octokit, event, GITHUB_ACTION, GITHUB_SHA).chain(check =>
          readFileToAnalyze(join(GITHUB_WORKSPACE, SPECTRAL_FILE_PATH))
            .chain(content => TaskEither.fromEither(parseJSON(content, e => e)))
            .chain(content => TaskEither.fromEither(oasDocument.decode(content)))
            .chain(parsed => runSpectral(parsed))
            .map(results => {
              return results.map<Octokit.ChecksUpdateParamsOutputAnnotations>(validationResult => {
                const annotation_level: Octokit.ChecksUpdateParamsOutputAnnotations['annotation_level'] =
                  validationResult.severity === DiagnosticSeverity.Error
                    ? 'failure'
                    : validationResult.severity === DiagnosticSeverity.Warning
                      ? 'warning'
                      : 'notice';

                const sameLine = validationResult.range.start.line === validationResult.range.end.line;

                return {
                  annotation_level,
                  message: validationResult.message,
                  title: validationResult.summary,
                  start_line: 1 + validationResult.range.start.line,
                  end_line: 1 + validationResult.range.end.line,
                  start_column: sameLine ? validationResult.range.start.character : undefined,
                  end_column: sameLine ? validationResult.range.end.character : undefined,
                  path: SPECTRAL_FILE_PATH
                };
              });
            })
            .chain(annotations =>
              updateGithubCheck(
                octokit,
                check,
                event,
                annotations,
                annotations.findIndex(f => f.annotation_level === 'failure') === -1 ? 'success' : 'failure'
              )
            )
            .mapLeft(e => updateGithubCheck(octokit, check, event, [], 'failure', String(e)))
        ));
  });

program.run().then((result: Either<string | object, unknown>) => result.fold(error, () => log('Worked fine')));
