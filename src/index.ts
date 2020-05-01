import { join } from 'path';
import { DiagnosticSeverity } from '@stoplight/types';
import { warning } from '@actions/core';
import { EOL } from 'os';
import { promises as fs } from 'fs';
import { array } from 'fp-ts/lib/Array';
import { flatten } from 'lodash';
import { Config } from './config';
import { runSpectral, createSpectral, fileWithContent } from './spectral';
import { pluralizer } from './utils';
import { createGithubCheck, createOctokitInstance, getRepositoryInfoFromEvent, updateGithubCheck } from './octokit';
import glob from 'fast-glob';
import { info, setFailed } from '@actions/core';
import * as IOEither from 'fp-ts/lib/IOEither';
import * as IO from 'fp-ts/lib/IO';
import * as TE from 'fp-ts/lib/TaskEither';
import * as T from 'fp-ts/lib/Task';
import * as E from 'fp-ts/lib/Either';
import { failure } from 'io-ts/lib/PathReporter';
import { pipe } from 'fp-ts/lib/pipeable';
import { identity } from 'lodash';
import { ChecksUpdateParamsOutputAnnotations } from '@octokit/rest';
import * as path from 'path';

const CHECK_NAME = 'Lint';
const traverseTask = array.traverse(T.task);

const createSpectralAnnotations = (ruleset: string, parsed: fileWithContent[], basePath: string) =>
  pipe(
    createSpectral(ruleset),
    TE.chain(spectral => {
      const spectralRuns = parsed.map(v =>
        pipe(
          runSpectral(spectral, v),
          TE.map(results => {
            info(`Done linting '${v.path}'`);

            if (results.length === 0) {
              info(' No issue detected');
            } else {
              info(` /!\\ ${pluralizer(results.length, 'issue')} detected`);
            }

            return { path: v.path, results };
          })
        )
      );
      return array.sequence(TE.taskEither)(spectralRuns);
    }),
    TE.map(results =>
      flatten(
        results.map(validationResult => {
          return validationResult.results.map<ChecksUpdateParamsOutputAnnotations>(vl => {
            const annotation_level: ChecksUpdateParamsOutputAnnotations['annotation_level'] =
              vl.severity === DiagnosticSeverity.Error
                ? 'failure'
                : vl.severity === DiagnosticSeverity.Warning
                ? 'warning'
                : 'notice';

            const sameLine = vl.range.start.line === vl.range.end.line;

            return {
              annotation_level,
              message: vl.message,
              title: vl.code as string,
              start_line: 1 + vl.range.start.line,
              end_line: 1 + vl.range.end.line,
              start_column: sameLine ? vl.range.start.character : undefined,
              end_column: sameLine ? vl.range.end.character : undefined,
              path: path.relative(basePath, validationResult.path),
            };
          });
        })
      ).sort((a, b) => (a.start_line > b.start_line ? 1 : -1))
    )
  );

const readFilesToAnalyze = (pattern: string, workingDir: string) => {
  const path = join(workingDir, pattern);

  const readFile = (file: string) => TE.tryCatch(() => fs.readFile(file, { encoding: 'utf8' }), E.toError);

  return pipe(
    TE.tryCatch(() => glob(path), E.toError),
    TE.map(fileList => {
      info(`Using glob '${pattern}' under '${workingDir}', found ${pluralizer(fileList.length, 'file')} to lint`);
      return fileList;
    }),
    TE.chain(fileList =>
      pipe(
        traverseTask(fileList, path =>
          pipe(
            readFile(path),
            TE.map<string, fileWithContent>(content => ({ path, content }))
          )
        ),
        T.map(e => {
          const separated = array.partitionMap<E.Either<Error, fileWithContent>, Error, fileWithContent>(e, identity);
          separated.left.map(e => warning(`Unable to read file: ${e.message}`));
          return E.right(separated.right);
        })
      )
    )
  );
};

const getEnv = IO.of(process.env);

const decodeConfig = (env: NodeJS.ProcessEnv) =>
  pipe(
    Config.decode(env),
    E.mapLeft(e => new Error(failure(e).join(EOL)))
  );

const createConfigFromEnv = pipe(
  IOEither.ioEither.fromIO<Error, NodeJS.ProcessEnv>(getEnv),
  IOEither.chain(env => IOEither.fromEither(decodeConfig(env)))
);

const program = pipe(
  TE.fromIOEither(createConfigFromEnv),
  TE.chain(
    ({
      INPUT_EVENT_NAME,
      GITHUB_EVENT_PATH,
      INPUT_REPO_TOKEN,
      GITHUB_WORKSPACE,
      INPUT_FILE_GLOB,
      INPUT_SPECTRAL_RULESET,
    }) =>
      pipe(
        getRepositoryInfoFromEvent(GITHUB_EVENT_PATH, INPUT_EVENT_NAME),
        TE.chain(event =>
          pipe(
            createOctokitInstance(INPUT_REPO_TOKEN),
            TE.map(octokit => ({ octokit, event }))
          )
        ),
        TE.chain(({ octokit, event }) =>
          pipe(
            createGithubCheck(octokit, event, `${CHECK_NAME} (${event.eventName})`),
            TE.map(check => ({ octokit, event, check }))
          )
        ),
        TE.chain(({ octokit, event, check }) =>
          pipe(
            readFilesToAnalyze(INPUT_FILE_GLOB, GITHUB_WORKSPACE),
            TE.chain(fileContents => createSpectralAnnotations(INPUT_SPECTRAL_RULESET, fileContents, GITHUB_WORKSPACE)),
            TE.chain(annotations =>
              pipe(
                updateGithubCheck(
                  octokit,
                  check,
                  event,
                  annotations,
                  annotations.findIndex(f => f.annotation_level === 'failure') === -1 ? 'success' : 'failure'
                ),
                TE.map(checkResponse => {
                  info(
                    `Check run '${checkResponse.data.name}' concluded with '${checkResponse.data.conclusion}' (${checkResponse.data.html_url})`
                  );
                  info(
                    `Commit ${event.sha} has been annotated (https://github.com/${event.owner}/${event.repo}/commit/${event.sha})`
                  );

                  const fatalErrors = annotations.filter(a => a.annotation_level === 'failure');
                  if (fatalErrors.length > 0) {
                    setFailed(`${pluralizer(fatalErrors.length, 'fatal issue')} detected. Failing the process.`);
                  }

                  return checkResponse;
                })
              )
            ),
            TE.orElse(e => {
              setFailed(e.message);
              return updateGithubCheck(octokit, check, event, [], 'failure', e.message);
            })
          )
        )
      )
  )
);

program().then(result =>
  pipe(
    result,
    E.fold(
      e => setFailed(`${e.message}\n${e.stack}`),
      () => info('Analysis is complete')
    )
  )
);
