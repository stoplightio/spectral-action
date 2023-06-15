import { join } from 'path';
import { DiagnosticSeverity } from '@stoplight/types';
import { warning } from '@actions/core';
import { promises as fs } from 'fs';
import { array } from 'fp-ts/Array';
import { Config } from './config';
import { runSpectral, createSpectral, FileWithContent } from './spectral';
import pluralize from 'pluralize';
import {
  Annotations,
  createGithubCheck,
  createOctokitInstance,
  getRepositoryInfoFromEvent,
  updateGithubCheck,
} from './octokit';
import glob from 'fast-glob';
import { error, info, setFailed } from '@actions/core';
import * as IOEither from 'fp-ts/IOEither';
import * as IO from 'fp-ts/IO';
import * as TE from 'fp-ts/TaskEither';
import * as T from 'fp-ts/Task';
import * as E from 'fp-ts/Either';
import * as D from 'io-ts/Decoder';
import { pipe } from 'fp-ts/pipeable';
import { identity } from 'lodash';
import * as path from 'path';

const CHECK_NAME = 'Lint';
const traverseTask = array.traverse(T.task);

const createSpectralAnnotations = (ruleset: string, parsed: FileWithContent[], basePath: string) =>
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
              info(` /!\\ ${pluralize('issue', results.length)} detected`);
            }

            return { path: v.path, results };
          })
        )
      );
      return array.sequence(TE.taskEither)(spectralRuns);
    }),
    TE.map(results =>
      results
        .flatMap(validationResult => {
          return validationResult.results.map<Annotations[0]>(vl => {
            const annotation_level: Annotations[0]['annotation_level'] =
              vl.severity === DiagnosticSeverity.Error
                ? 'failure'
                : vl.severity === DiagnosticSeverity.Warning
                ? 'warning'
                : 'notice';

            const sameLine = vl.range.start.line === vl.range.end.line;

            return {
              annotation_level,
              message: vl.message,
              title: String(vl.code),
              start_line: 1 + vl.range.start.line,
              end_line: 1 + vl.range.start.line,
              start_column: sameLine ? vl.range.start.character : undefined,
              end_column: sameLine ? vl.range.end.character : undefined,
              path: path.relative(basePath, vl.source || validationResult.path),
            };
          });
        })
        .sort((a, b) => (a.start_line > b.start_line ? 1 : -1))
    )
  );

const readFilesToAnalyze = (pattern: string, workingDir: string) => {
  const path = join(workingDir, pattern);

  const readFile = (file: string) => TE.tryCatch(() => fs.readFile(file, { encoding: 'utf8' }), E.toError);

  return pipe(
    TE.tryCatch(() => glob(path), E.toError),
    TE.map(fileList => {
      info(`Using glob '${pattern}' under '${workingDir}', found ${pluralize('file', fileList.length)} to lint`);
      return fileList;
    }),
    TE.chain(fileList =>
      pipe(
        traverseTask(fileList, path =>
          pipe(
            readFile(path),
            TE.map<string, FileWithContent>(content => ({ path, content }))
          )
        ),
        T.map(e => {
          const separated = array.partitionMap<E.Either<Error, FileWithContent>, Error, FileWithContent>(e, identity);
          separated.left.map(e => warning(`Unable to read file: ${e.message}`));
          return E.right(separated.right);
        })
      )
    )
  );
};

const getEnv = IO.of(
  Object.entries(process.env).reduce(
    (p, [k, v]) => ({ ...p, [k]: ['true', 'false'].includes(v || '') ? v == 'true' : v }),
    {}
  )
);

const decodeConfig = (env: NodeJS.ProcessEnv) =>
  pipe(
    Config.decode(env),
    E.mapLeft(e => new Error(D.draw(e)))
  );

const createConfigFromEnv = pipe(
  IOEither.fromIO<Error, NodeJS.ProcessEnv>(getEnv),
  IOEither.chainEitherK(env => decodeConfig(env))
);

const program = pipe(
  TE.fromIOEither(createConfigFromEnv),
  TE.bindTo('config'),
  TE.bind('repositoryInfo', ({ config }) =>
    TE.fromEither(getRepositoryInfoFromEvent(config.GITHUB_EVENT_PATH, config.INPUT_EVENT_NAME))
  ),
  TE.bind('octokit', ({ config }) => TE.fromEither(createOctokitInstance(config.INPUT_REPO_TOKEN))),
  TE.bind('fileContents', ({ config }) => readFilesToAnalyze(config.INPUT_FILE_GLOB, config.GITHUB_WORKSPACE)),
  TE.bind('annotations', ({ fileContents, config }) =>
    createSpectralAnnotations(config.INPUT_SPECTRAL_RULESET, fileContents, config.GITHUB_WORKSPACE)
  ),
  TE.bind('check', ({ octokit, repositoryInfo }) =>
    createGithubCheck(octokit, repositoryInfo, `${CHECK_NAME} (${repositoryInfo.eventName})`)
  ),
  TE.bind('checkResponse', ({ octokit, check, repositoryInfo, annotations }) =>
    updateGithubCheck(
      octokit,
      check.data,
      repositoryInfo,
      annotations,
      annotations.findIndex(f => f.annotation_level === 'failure') === -1 ? 'success' : 'failure'
    )
  ),
  TE.map(({ config, checkResponse, repositoryInfo, annotations }) => {
    checkResponse.map(res => {
      info(`Check run '${res.data.name}' concluded with '${res.data.conclusion}' (${res.data.html_url})`);
      info(
        `Commit ${repositoryInfo.sha} has been annotated (${config.GITHUB_SERVER_URL}/${repositoryInfo.owner}/${repositoryInfo.repo}/commit/${repositoryInfo.sha})`
      );
    });

    const fatalErrors = annotations.filter(a => a.annotation_level === 'failure');
    if (fatalErrors.length > 0) {
      setFailed(`${pluralize('fatal issue', fatalErrors.length)} detected. Failing the process.`);
    }

    return checkResponse;
  })
);

program().then(result =>
  pipe(
    result,
    E.fold(
      e => error(e.message),
      () => info('Analysis is complete')
    )
  )
);
