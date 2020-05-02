import { GitHub } from '@actions/github';
import * as TE from 'fp-ts/lib/TaskEither';
import * as E from 'fp-ts/lib/Either';
import { Do } from 'fp-ts-contrib/lib/Do';
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
  eventName: string;
  sha: string;
}

const extractSha = (eventName: string, event: any): E.Either<Error, string> => {
  switch (eventName) {
    case 'pull_request':
      return E.right(event.pull_request.head.sha);
    case 'push':
      return E.right(event.after);
    default:
      return E.left(Error(`Unsupported event '${eventName}'`));
  }
};

function buildRepositoryInfoFrom(event: Event, eventName: string, sha: string): IRepositoryInfo {
  const { repository } = event;
  const {
    owner: { login: owner },
  } = repository;
  const { name: repo } = repository;

  return { owner, repo, eventName, sha };
}

export const getRepositoryInfoFromEvent = (eventPath: string, eventName: string): E.Either<Error, IRepositoryInfo> =>
  Do(E.either)
    .bind(
      'event',
      E.tryCatch<Error, Event>(() => require(eventPath), E.toError)
    )
    .bindL('sha', ({ event }) => extractSha(eventName, event))
    .return(({ event, sha }) => buildRepositoryInfoFrom(event, eventName, sha));

export const updateGithubCheck = (
  octokit: GitHub,
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
        name: check.data.name,
        repo: event.repo,
        status: 'completed',
        conclusion,
        completed_at: new Date().toISOString(),
        output: {
          title: check.data.name,
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
