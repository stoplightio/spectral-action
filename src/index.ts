import { join } from 'path';
import { DiagnosticSeverity } from '@stoplight/types';
import { EOL } from 'os';
import { promises as fs } from 'fs';
import { Config } from './config';
import { runSpectral, createSpectral } from './spectral';
import { createGithubCheck, createOctokitInstance, getRepositoryInfoFromEvent, updateGithubCheck } from './octokit';

import { info, setFailed } from '@actions/core';
import * as IOEither from 'fp-ts/lib/IOEither';
import * as IO from 'fp-ts/lib/IO';
import * as TaskEither from 'fp-ts/lib/TaskEither';
import * as Either from 'fp-ts/lib/Either';
import { failure } from 'io-ts/lib/PathReporter';
import { pipe } from 'fp-ts/lib/pipeable';
import { ChecksUpdateParamsOutputAnnotations } from '@octokit/rest';

const createSpectralAnnotations = (path: string, ruleset: string, parsed: string) =>
  pipe(
    createSpectral(ruleset),
    TaskEither.chain(spectral => runSpectral(spectral, parsed)),
    TaskEither.map(results =>
      results
        .map<ChecksUpdateParamsOutputAnnotations>(validationResult => {
          const annotation_level: ChecksUpdateParamsOutputAnnotations['annotation_level'] =
            validationResult.severity === DiagnosticSeverity.Error
              ? 'failure'
              : validationResult.severity === DiagnosticSeverity.Warning
              ? 'warning'
              : 'notice';

          const sameLine = validationResult.range.start.line === validationResult.range.end.line;

          return {
            annotation_level,
            message: validationResult.message,
            title: validationResult.code as string,
            start_line: 1 + validationResult.range.start.line,
            end_line: 1 + validationResult.range.end.line,
            start_column: sameLine ? validationResult.range.start.character : undefined,
            end_column: sameLine ? validationResult.range.end.character : undefined,
            path,
          };
        })
        .sort((a, b) => (a.start_line > b.start_line ? 1 : -1))
    )
  );

const readFileToAnalyze = (path: string) =>
  pipe(TaskEither.tryCatch(() => fs.readFile(path, { encoding: 'utf8' }), Either.toError));

const getEnv = IO.of(process.env);

const decodeConfig = (env: NodeJS.ProcessEnv) =>
  pipe(
    Config.decode(env),
    Either.mapLeft(e => new Error(failure(e).join(EOL)))
  );

const createConfigFromEnv = pipe(
  IOEither.ioEither.fromIO<Error, NodeJS.ProcessEnv>(getEnv),
  IOEither.chain(env => IOEither.fromEither(decodeConfig(env)))
);

const program = pipe(
  TaskEither.fromIOEither(createConfigFromEnv),
  TaskEither.chain(
    ({
      GITHUB_EVENT_PATH,
      INPUT_REPO_TOKEN,
      GITHUB_SHA,
      GITHUB_WORKSPACE,
      GITHUB_ACTION,
      INPUT_FILE_PATH,
      INPUT_SPECTRAL_RULESET,
    }) =>
      pipe(
        getRepositoryInfoFromEvent(GITHUB_EVENT_PATH),
        TaskEither.chain(event =>
          pipe(
            createOctokitInstance(INPUT_REPO_TOKEN),
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
            readFileToAnalyze(join(GITHUB_WORKSPACE, INPUT_FILE_PATH)),
            TaskEither.chain(content => createSpectralAnnotations(INPUT_FILE_PATH, INPUT_SPECTRAL_RULESET, content)),
            TaskEither.chain(annotations => {
              info(`${annotations.length} annotations found on ${INPUT_FILE_PATH}`);
              return updateGithubCheck(
                octokit,
                GITHUB_ACTION,
                check,
                event,
                annotations,
                annotations.findIndex(f => f.annotation_level === 'failure') === -1 ? 'success' : 'failure'
              );
            }),
            TaskEither.orElse(e => {
              setFailed(e.message);
              return updateGithubCheck(octokit, GITHUB_ACTION, check, event, [], 'failure', e.message);
            })
          )
        )
      )
  )
);

program().then(result =>
  pipe(
    result,
    Either.fold(
      e => setFailed(e.message),
      res => info(`Linting completed with: ${JSON.stringify(res.data, undefined, 2)}`)
    )
  )
);
