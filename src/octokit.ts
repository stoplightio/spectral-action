import { getOctokit } from '@actions/github';
import * as TE from 'fp-ts/TaskEither';
import * as E from 'fp-ts/Either';
import * as D from 'io-ts/Decoder';
import { sequence } from 'fp-ts/Array';
import type { Endpoints, GetResponseDataTypeFromEndpointMethod } from '@octokit/types';
import { pipe } from 'fp-ts/function';
import { chunk } from 'lodash';

const sequenceTaskEither = sequence(TE.taskEither);

export type Annotations = NonNullable<
  NonNullable<Endpoints['PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}']['parameters']['output']>['annotations']
>;
type Conclusions = Endpoints['PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}']['parameters']['conclusion'];
type GitHub = ReturnType<typeof getOctokit>;

const RepositoryStruct = D.struct({
  name: D.string,
  owner: D.struct({
    login: D.string,
  }),
});

const PullRequestEvent = pipe(
  D.struct({
    repository: RepositoryStruct,
    pull_request: D.struct({
      head: D.struct({
        sha: D.string,
      }),
    }),
  }),
  D.intersect(
    D.partial({
      after: D.string,
    })
  )
);

const PushEvent = D.struct({
  after: D.string,
  repository: RepositoryStruct,
});

const EventDecoder = D.union(PullRequestEvent, PushEvent);

type Event = D.TypeOf<typeof EventDecoder>;

export const createOctokitInstance = (token: string) => E.tryCatch(() => getOctokit(token), E.toError);

export const createGithubCheck = (octokit: GitHub, event: RepositoryInfo, name: string) =>
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

export interface RepositoryInfo {
  owner: string;
  repo: string;
  eventName: string;
  sha: string;
}

const extractSha = (eventName: string, event: any): E.Either<Error, string> => {
  switch (eventName) {
    case 'pull_request':
    case 'pull_request_target':
      return E.right(event.pull_request ? event.pull_request.head.sha : event.after);
    case 'push':
      return E.right(event.after);
    default:
      return E.left(Error(`Unsupported event '${eventName}'`));
  }
};

function buildRepositoryInfoFrom(event: Event, eventName: string, sha: string): RepositoryInfo {
  const { repository } = event;
  const {
    owner: { login: owner },
  } = repository;
  const { name: repo } = repository;

  return { owner, repo, eventName, sha };
}

const decodeEvent = (event: unknown) =>
  pipe(
    EventDecoder.decode(event),
    E.mapLeft(errors => new Error(D.draw(errors)))
  );

const parseEventFile = (eventPath: string) =>
  pipe(
    E.tryCatch<Error, unknown>(() => require(eventPath), E.toError),
    E.chain(decodeEvent)
  );

export const getRepositoryInfoFromEvent = (eventPath: string, eventName: string): E.Either<Error, RepositoryInfo> =>
  pipe(
    parseEventFile(eventPath),
    E.bindTo('event'),
    E.bind('sha', ({ event }) => extractSha(eventName, event)),
    E.map(({ event, sha }) => buildRepositoryInfoFrom(event, eventName, sha))
  );

export const updateGithubCheck = (
  octokit: GitHub,
  check: GetResponseDataTypeFromEndpointMethod<typeof octokit.checks.create>,
  event: RepositoryInfo,
  annotations: Annotations,
  conclusion: Conclusions,
  message?: string
) => {
  const chunkedAnnotations = annotations.length ? chunk(annotations) : [[]];

  const updateAttempts = chunkedAnnotations.map(annotationChunk =>
    TE.tryCatch(
      () =>
        octokit.checks.update({
          check_run_id: check.id,
          owner: event.owner,
          name: check.name,
          repo: event.repo,
          status: 'completed',
          conclusion,
          completed_at: new Date().toISOString(),
          output: {
            title: check.name,
            summary: message
              ? message
              : conclusion === 'success'
              ? 'Lint completed successfully'
              : 'Lint completed with some errors',

            annotations: annotationChunk,
          },
        }),
      E.toError
    )
  );

  return sequenceTaskEither(updateAttempts);
};
