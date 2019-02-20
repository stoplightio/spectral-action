import * as Octokit from '@octokit/rest'
import { Spectral } from '@stoplight/spectral'
import { join } from 'path'
import { pathToPointer } from "@stoplight/json";
import { parseWithPointers } from "@stoplight/json/parseWithPointers";
import { readFileSync } from 'fs'
import { oas2Functions, oas2Rules } from '@stoplight/spectral/rulesets/oas2';
import { oas3Functions, oas3Rules } from '@stoplight/spectral/rulesets/oas3';
import { ValidationSeverity } from '@stoplight/types/validations';
import { Future, Option, Try } from 'funfix';

const { GITHUB_EVENT_PATH, GITHUB_TOKEN, GITHUB_SHA, GITHUB_WORKSPACE, SPECTRAL_FILE_PATH } = process.env

const spectral = new Spectral();
spectral.addFunctions(oas2Functions());
spectral.addRules(oas2Rules());
spectral.addFunctions(oas3Functions());
spectral.addRules(oas3Rules());

Option.map5(
  Option.of(GITHUB_EVENT_PATH),
  Option.of(GITHUB_TOKEN),
  Option.of(GITHUB_SHA),
  Option.of(GITHUB_WORKSPACE),
  Option.of(SPECTRAL_FILE_PATH),
  (GITHUB_EVENT_PATH, GITHUB_TOKEN, GITHUB_SHA, GITHUB_WORKSPACE, SPECTRAL_FILE_PATH) => {
    return Try.map2(
      Try.of(() => require(GITHUB_EVENT_PATH)),
      Try.of(() => new Octokit({ auth: `token ${GITHUB_TOKEN}` }))
      , (event, octokit) => {

        const { repository } = event
        const { owner: { login: owner } } = repository
        const { name: repo } = repository

        return Future
          .fromPromise(octokit.checks.create({ owner, repo, name: 'Spectral Lint Check', head_sha: GITHUB_SHA }))
          .map(check => {
            const fileContent = readFileSync(join(GITHUB_WORKSPACE, SPECTRAL_FILE_PATH), { encoding: 'utf8' })
            const parsed = parseWithPointers(fileContent);
            const { results } = spectral.run(parsed.data, { resolvedTarget: parsed.data });

            const annotations: Octokit.ChecksUpdateParamsOutputAnnotations[] = results.map(validationResult => {
              const path = pathToPointer(validationResult.path as string[]).slice(1);
              const position = Option.of(parsed.pointers[path]).getOrElse({
                start: { line: 0, column: undefined },
                end: { line: 0, column: undefined }
              });

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

            return Future.fromPromise(octokit.checks.update({
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
  });
