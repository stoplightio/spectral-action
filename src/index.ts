import * as Octokit from '@octokit/rest'
import { Spectral } from '@stoplight/spectral'
import { join } from 'path'
import { pathToPointer } from "@stoplight/json";
import { parseWithPointers } from "@stoplight/json/parseWithPointers";
import { readFileSync } from 'fs'
import { oas2Functions, oas2Rules } from '@stoplight/spectral/rulesets/oas2';
import { oas3Functions, oas3Rules } from '@stoplight/spectral/rulesets/oas3';
import { ValidationSeverity } from '@stoplight/types/validations';
import { Future } from 'funfix';

const { GITHUB_EVENT_PATH, GITHUB_TOKEN, GITHUB_SHA, GITHUB_WORKSPACE, SPECTRAL_FILE_PATH } = process.env

if (!GITHUB_EVENT_PATH || !GITHUB_TOKEN || !GITHUB_SHA || !GITHUB_WORKSPACE || !SPECTRAL_FILE_PATH) {
  console.error('Missing required environment variables');
  process.exit(1);
} else {
  const event = require(GITHUB_EVENT_PATH);
  const { repository } = event
  const { owner: { login: owner } } = repository
  const { name: repo } = repository

  const octokit = new Octokit({ auth: `token ${GITHUB_TOKEN}` });

  const spectral = new Spectral();
  spectral.addFunctions(oas2Functions());
  spectral.addRules(oas2Rules());
  spectral.addFunctions(oas3Functions());
  spectral.addRules(oas3Rules());

  Future
    .fromPromise(octokit.checks.create({ owner, repo, name: 'Spectral Lint Check', head_sha: GITHUB_SHA }))
    .chain(check => {
      const fileContent = readFileSync(join(GITHUB_WORKSPACE, SPECTRAL_FILE_PATH), { encoding: 'utf8' })
      const parsed = parseWithPointers(fileContent);
      const { results } = spectral.run(parsed.data, { resolvedTarget: parsed.data });

      const annotations: Octokit.ChecksUpdateParamsOutputAnnotations[] = results.map(validationResult => {
        const path = pathToPointer(validationResult.path as string[]).slice(1);
        const position = parsed.pointers[path];

        const annotation_level: "notice" | "warning" | "failure"
          = validationResult.severity === ValidationSeverity.Error ? 'failure'
            : validationResult.severity === ValidationSeverity.Warn ? 'warning' : 'notice';

        return {
          annotation_level,
          message: validationResult.summary,
          title: validationResult.name,
          start_line: position ? position.start.line : 0,
          end_line: position && position.end ? position.end.line : 0,
          start_column: position && position.start.column ? position.start.column : undefined,
          end_column: position && position.end && position.end.column ? position.end.column : undefined,
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
}
