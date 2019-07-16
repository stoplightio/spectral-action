import * as Octokit from "@octokit/rest";
import * as TaskEither from "fp-ts/lib/TaskEither";
import * as IOEither from "fp-ts/lib/IOEither";
import * as Either from "fp-ts/lib/Either";
import { pipe } from "fp-ts/lib/pipeable";

type Event = {
  repository: {
    name: string;
    owner: {
      login: string;
    };
  };
};

export const createOctokitInstance = (token: string) =>
  TaskEither.fromIOEither(
    IOEither.tryCatch(
      () => new Octokit({ auth: `token ${token}` }),
      e => Either.toError(e).message
    )
  );

export const createGithubCheck = (
  octokit: Octokit,
  event: { owner: string; repo: string },
  name: string,
  head_sha: string
) =>
  TaskEither.tryCatch(
    () =>
      octokit.checks.create({
        owner: event.owner,
        repo: event.repo,
        name,
        head_sha
      }),
    e => Either.toError(e).message
  );

export const getRepositoryInfoFromEvent = (eventPath: string) =>
  pipe(
    TaskEither.fromIOEither(
      IOEither.tryCatch<string, Event>(
        () => require(eventPath),
        e => Either.toError(e).message
      )
    ),
    TaskEither.map(event => {
      const { repository } = event;
      const {
        owner: { login: owner }
      } = repository;
      const { name: repo } = repository;
      return { owner, repo };
    })
  );

export const updateGithubCheck = (
  octokit: Octokit,
  actionName: string,
  check: Octokit.Response<Octokit.ChecksCreateResponse>,
  event: { owner: string; repo: string },
  annotations: Octokit.ChecksUpdateParamsOutputAnnotations[],
  conclusion: Octokit.ChecksUpdateParams["conclusion"],
  message?: string
) =>
  TaskEither.tryCatch(
    () =>
      octokit.checks.update({
        check_run_id: check.data.id,
        owner: event.owner,
        name: actionName,
        repo: event.repo,
        status: "completed",
        conclusion,
        completed_at: new Date().toISOString(),
        output: {
          title: actionName,
          summary: message
            ? message
            : conclusion === "success"
            ? "Lint completed successfully"
            : "Lint completed with some errors",
          annotations
        }
      }),
    e => Either.toError(e).message
  );
