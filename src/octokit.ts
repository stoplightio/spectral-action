import { GitHub } from '@actions/github';
import * as TE from 'fp-ts/lib/TaskEither';
import * as E from 'fp-ts/lib/Either';
import { pipe } from 'fp-ts/lib/pipeable';
import { ChecksCreateResponse, ChecksUpdateParamsOutputAnnotations, ChecksUpdateParams, Response } from '@octokit/rest';

type Event = {
  after: string;
  repository: {
    name: string;
    owner: {
      login: string;
    };
  };
};

export const createOctokitInstance = (token: string) => TE.fromEither(E.tryCatch(() => new GitHub(token), E.toError));

export const createGithubCheck = (octokit: GitHub, event: IRepositoryInfo, name: string) =>
  TE.tryCatch(
    () =>
      octokit.checks.create({
        owner: event.owner,
        repo: event.repo,
        name,
        head_sha: event.sha,
        status: 'in_progress',
      }),
    E.toError
  );

export interface IRepositoryInfo {
  owner: string;
  repo: string;
  sha: string;
}

export const getRepositoryInfoFromEvent = (eventPath: string): TE.TaskEither<Error, IRepositoryInfo> =>
  pipe(
    TE.fromEither(E.tryCatch<Error, Event>(() => require(eventPath), E.toError)),
    TE.map(event => {
      const { repository, after } = event;
      const {
        owner: { login: owner },
      } = repository;
      const { name: repo } = repository;
      return { owner, repo, sha: after };
    })
  );

export const updateGithubCheck = (
  octokit: GitHub,
  actionName: string,
  check: Response<ChecksCreateResponse>,
  event: IRepositoryInfo,
  annotations: ChecksUpdateParamsOutputAnnotations[],
  conclusion: ChecksUpdateParams['conclusion'],
  message?: string
) =>
  TE.tryCatch(
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

          // TODO: Split calls when annotations.length > 50
          // From https://octokit.github.io/rest.js/v17#checks-update
          // => "The Checks API limits the number of annotations to a maximum of 50 per API request.
          // To create more than 50 annotations, you have to make multiple requests to the Update a check run endpoint."
          annotations,
        },
      }),
    E.toError
  );
