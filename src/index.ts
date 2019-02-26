import * as Octokit from '@octokit/rest'
import { Spectral } from '@stoplight/spectral'
import { join } from 'path'
import { pathToPointer } from "@stoplight/json";
import { parseWithPointers } from "@stoplight/json/parseWithPointers";
import { readFileSync } from 'fs'
import { oas2Functions, oas2Rules } from '@stoplight/spectral/rulesets/oas2';
import { oas3Functions, oas3Rules } from '@stoplight/spectral/rulesets/oas3';
import { ValidationSeverity } from '@stoplight/types/validations';
import { IOEither } from 'fp-ts/lib/IOEither';
import { fromNullable } from 'fp-ts/lib/Option';
import { IO } from 'fp-ts/lib/IO';
import { Task } from 'fp-ts/lib/Task';
import * as t from 'io-ts'
import { failure } from 'io-ts/lib/PathReporter'
import { IPathPosition } from '@stoplight/types/parsers';

const Config = t.strict({
  GITHUB_EVENT_PATH: t.string,
  GITHUB_TOKEN: t.string,
  GITHUB_SHA: t.string,
  GITHUB_WORKSPACE: t.string,
  SPECTRAL_FILE_PATH: t.string
})

type Config = t.TypeOf<typeof Config>

const spectral = new Spectral();
spectral.addFunctions(oas2Functions());
spectral.addRules(oas2Rules());
spectral.addFunctions(oas3Functions());
spectral.addRules(oas3Rules());


function isDefined(t: IPathPosition): t is Required<IPathPosition> {
  return !!t.end;
}
const createConfigFromEnv: IOEither<t.Errors, Config> = new IOEither(new IO(() => Config.decode(process.env)));

createConfigFromEnv
  .map(({
    GITHUB_EVENT_PATH,
    GITHUB_TOKEN,
    GITHUB_SHA,
    GITHUB_WORKSPACE,
    SPECTRAL_FILE_PATH
  }) => {
    const event = require(GITHUB_EVENT_PATH)
    const { repository } = event
    const { owner: { login: owner } } = repository
    const { name: repo } = repository

    const octokit = new Octokit({ auth: `token ${GITHUB_TOKEN}` })

    new Task(() => octokit.checks.create({ owner, repo, name: 'Spectral Lint Check', head_sha: GITHUB_SHA }))
      .map(check => {
        const fileContent = readFileSync(join(GITHUB_WORKSPACE, SPECTRAL_FILE_PATH), { encoding: 'utf8' })
        const parsed = parseWithPointers(fileContent);
        const { results } = spectral.run(parsed.data, { resolvedTarget: parsed.data });

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
        });

        return new Task(() => octokit.checks.update({
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
        }));
      });
  })
  .mapLeft(e => failure(e).map(console.error))
  .run();
