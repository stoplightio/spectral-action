import { join } from 'path'
import * as Octokit from '@octokit/rest'
import { Spectral } from '@stoplight/spectral'
import { pathToPointer } from "@stoplight/json";
import { parseWithPointers } from "@stoplight/json/parseWithPointers";
import { readFileSync } from 'fs'
import { oas2Functions, oas2Rules } from '@stoplight/spectral/rulesets/oas2';
import { oas3Functions, oas3Rules } from '@stoplight/spectral/rulesets/oas3';
import { ValidationSeverity } from '@stoplight/types/validations';
import { IPathPosition } from '@stoplight/types/parsers';
import { IOEither, tryCatch2v } from 'fp-ts/lib/IOEither';
import { fromNullable } from 'fp-ts/lib/Option';
import { IO } from 'fp-ts/lib/IO';
import { Task } from 'fp-ts/lib/Task';
import { fromIOEither, tryCatch } from 'fp-ts/lib/TaskEither';
import { Either } from 'fp-ts/lib/Either';
import * as t from 'io-ts'
import { error, log } from 'console';
import { failure } from 'fp-ts/lib/Validation';

const map2 = <A, B, C>(fa: IOEither<unknown, A>, fb: IOEither<unknown, B>, f: (a: A, b: B) => C): IOEither<unknown, C> =>
  fa.chain(a => fb.map(b => f(a, b)))

const Config = t.strict({
  GITHUB_EVENT_PATH: t.string,
  GITHUB_TOKEN: t.string,
  GITHUB_SHA: t.string,
  GITHUB_WORKSPACE: t.string,
  SPECTRAL_FILE_PATH: t.string
})

type Config = t.TypeOf<typeof Config>

type Event = {
  repository: {
    name: string,
    owner: {
      login: string
    }
  }
};

const createSpectral = () => {
  const spectral = new Spectral();
  spectral.addFunctions(oas2Functions());
  spectral.addRules(oas2Rules());
  spectral.addFunctions(oas3Functions());
  spectral.addRules(oas3Rules());

  return spectral;
}

function isDefined(t: IPathPosition): t is Required<IPathPosition> {
  return !!t.end;
}

const getEnv: IO<NodeJS.ProcessEnv> = new IO(() => process.env);
const getConfig: IO<Either<t.Errors, Config>> = getEnv.map(env => Config.decode(env));
const createConfigFromEnv = fromIOEither(new IOEither(getConfig));

createConfigFromEnv
  .map(({
    GITHUB_EVENT_PATH,
    GITHUB_TOKEN,
    GITHUB_SHA,
    GITHUB_WORKSPACE,
    SPECTRAL_FILE_PATH
  }) => {

    const repository =
      tryCatch2v<NodeJS.ErrnoException, Event>(() => require(GITHUB_EVENT_PATH), e => e as NodeJS.ErrnoException)
        .map(event => {
          const { repository } = event
          const { owner: { login: owner } } = repository
          const { name: repo } = repository
          return { owner, repo };
        });

    const octokit = tryCatch2v(() => new Octokit({ auth: `token ${GITHUB_TOKEN}` }), r => String(r));

    return map2(repository, octokit, ({ owner, repo }, kit) => {
      return tryCatch(() => kit.checks.create({ owner, repo, name: 'Spectral Lint Check', head_sha: GITHUB_SHA }), e => String(e))
        .chain(check =>
          fromIOEither(tryCatch2v(() => readFileSync(join(GITHUB_WORKSPACE, SPECTRAL_FILE_PATH), { encoding: 'utf8' }), e => String(e))
            .chain(fileContent => tryCatch2v(() => parseWithPointers(fileContent), e => String(e)))
            .chain(parsed => tryCatch2v(() => ({ parsed, results: createSpectral().run(parsed.data, { resolvedTarget: parsed.data }).results }), e => String(e)))
            .map(({ results, parsed }) => {
              const defaultAnnotation: Required<IPathPosition> = {
                start: { line: 0, column: undefined },
                end: { line: 0, column: undefined }
              };

              const annotations: Octokit.ChecksUpdateParamsOutputAnnotations[] = results.map(validationResult => {
                const path = pathToPointer(validationResult.path as string[]).slice(1);
                const position = fromNullable(parsed.pointers[path])
                  .filter(isDefined)
                  .map(pointer => ({ ...defaultAnnotation, ...pointer }))
                  .getOrElse(defaultAnnotation);

                const annotation_level: "notice" | "warning" | "failure"
                  = validationResult.severity === ValidationSeverity.Error ? 'failure'
                    : validationResult.severity === ValidationSeverity.Warn ? 'warning' : 'notice';

                return {
                  annotation_level,
                  message: validationResult.summary,
                  title: validationResult.name,
                  start_line: position.start.line,
                  end_line: position.end.line,
                  start_column: position.start.column,
                  end_column: position.end.column,
                  path: SPECTRAL_FILE_PATH
                }
              })

              return new Task(() => kit.checks.update({
                check_run_id: check.data.id,
                owner,
                name: 'Spectral Lint Check',
                repo,
                status: 'completed',
                conclusion: 'failure',
                completed_at: (new Date()).toISOString(),
                output: {
                  title: 'Spectral Lint Check',
                  summary: 'This was horrible',
                  annotations
                }
              }))
            })
          )
        )
    })
  }).run()
  .then(result => result.fold(
    err => error(failure(err)),
    () => log('Worked fine')
  )
  ).catch(error);
