import { join } from 'path';
import * as Octokit from '@octokit/rest';
import { Spectral } from '@stoplight/spectral';
import { promises as fs } from 'fs';
import { oas2Functions, oas2Rules } from '@stoplight/spectral/rulesets/oas2';
import { oas3Functions, oas3Rules } from '@stoplight/spectral/rulesets/oas3';
import { DiagnosticSeverity } from '@stoplight/types';
import { IOEither, tryCatch2v } from 'fp-ts/lib/IOEither';
import { IO } from 'fp-ts/lib/IO';
import * as TaskEither from 'fp-ts/lib/TaskEither';
import { Either, parseJSON, toError } from 'fp-ts/lib/Either';
import * as t from 'io-ts';
import { error, log } from 'fp-ts/lib/Console';
import { failure } from 'io-ts/lib/PathReporter';

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

const createSpectralAnnotations = (path: string, parsed: oasDocument) =>
  TaskEither.tryCatch(() => createSpectral(parsed.swagger ? 'oas2' : 'oas3').run(parsed), e => toError(e).message).map(results =>
    results.map<Octokit.ChecksUpdateParamsOutputAnnotations>(validationResult => {
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
        path
      };
    })
  );

const createOctokitInstance = (token: string) =>
  TaskEither.fromIOEither(tryCatch2v(() => new Octokit({ auth: `token ${token}` }), e => toError(e).message));

const createGithubCheck = (octokit: Octokit, event: { owner: string; repo: string }, name: string, head_sha: string) =>
  TaskEither.tryCatch(
    () =>
      octokit.checks.create({
        owner: event.owner,
        repo: event.repo,
        name,
        head_sha
      }),
    e => toError(e).message
  );

const readFileToAnalyze = (path: string) =>
  TaskEither.tryCatch(() => fs.readFile(path, { encoding: 'utf8' }), e => toError(e).message)
    .chain(content => TaskEither.fromEither(
      parseJSON(content, e => toError(e).message)
        .chain(content => oasDocument.decode(content).mapLeft(e => failure(e).join('\n')))
    ));

const getRepositoryInfoFromEvent = (eventPath: string) => TaskEither.fromIOEither(
  tryCatch2v<string, Event>(() => require(eventPath), e => toError(e).message)
).map(event => {
  const { repository } = event;
  const {
    owner: { login: owner }
  } = repository;
  const { name: repo } = repository;
  return { owner, repo };
});

const updateGithubCheck = (
  octokit: Octokit,
  actionName: string,
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
        name: actionName,
        repo: event.repo,
        status: 'completed',
        conclusion,
        completed_at: new Date().toISOString(),
        output: {
          title: actionName,
          summary: message
            ? message
            : conclusion === 'success'
              ? 'Lint completed successfully'
              : 'Lint completed with some errors',
          annotations
        }
      }),
    e => toError(e).message
  );


const getEnv: IO<NodeJS.ProcessEnv> = new IO(() => process.env);
const getConfig: IO<Either<t.Errors, Config>> = getEnv.map(env => Config.decode(env));
const createConfigFromEnv = TaskEither.fromIOEither(new IOEither(getConfig)).mapLeft(errors => failure(errors).join('\n'));

const program = createConfigFromEnv
  .chain(({ GITHUB_EVENT_PATH, GITHUB_TOKEN, GITHUB_SHA, GITHUB_WORKSPACE, GITHUB_ACTION, SPECTRAL_FILE_PATH }) =>
    getRepositoryInfoFromEvent(GITHUB_EVENT_PATH)
      .chain(event => createOctokitInstance(GITHUB_TOKEN).map(octokit => ({ octokit, event })))
      .chain(({ octokit, event }) => createGithubCheck(octokit, event, GITHUB_ACTION, GITHUB_SHA)
        .map(check => ({ octokit, event, check })))
      .chain(({ octokit, event, check }) =>
        readFileToAnalyze(join(GITHUB_WORKSPACE, SPECTRAL_FILE_PATH))
          .chain(content => createSpectralAnnotations(SPECTRAL_FILE_PATH, content))
          .chain(annotations =>
            updateGithubCheck(
              octokit,
              GITHUB_ACTION,
              check,
              event,
              annotations,
              annotations.findIndex(f => f.annotation_level === 'failure') === -1 ? 'success' : 'failure'
            )
          ).orElse(e => updateGithubCheck(octokit, GITHUB_ACTION, check, event, [], 'failure', toError(e).message))
      )
  );

program.run().then((result: Either<string, unknown>) => result.fold(error, () => log('Worked fine')));
