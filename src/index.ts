import * as Octokit from '@octokit/rest'
import { Spectral } from '@stoplight/spectral'
import { join } from 'path'
import { defaultRules } from '@stoplight/spectral/rulesets/index'

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

  octokit.checks.create({ owner, repo, name: 'Spectral Lint', head_sha: GITHUB_SHA }).then(check => {
    const spectral = new Spectral();
    spectral.addRules(defaultRules());
    const payload = require(join(GITHUB_WORKSPACE, SPECTRAL_FILE_PATH))
    const result = spectral.run(payload);
    console.log(result);

    return octokit.checks.update({
      check_run_id: check.data.id,
      owner,
      repo,
      status: 'completed',
      conclusion: 'failure'
    });
  }).catch(e => { console.error(e); process.exit(1) });

}
