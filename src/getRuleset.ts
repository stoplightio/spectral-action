import * as fs from 'fs';
import * as process from 'process';
import type { Optional } from '@stoplight/types';
import { Ruleset } from '@stoplight/spectral-core';
import { info, error } from '@actions/core';
import * as path from '@stoplight/path';
import { fetch } from '@stoplight/spectral-runtime';
import type { IO } from '@stoplight/spectral-ruleset-bundler';
import { builtins } from '@stoplight/spectral-ruleset-bundler/plugins/builtins';
import { commonjs } from '@stoplight/spectral-ruleset-bundler/plugins/commonjs';
import { bundleAndLoadRuleset } from '@stoplight/spectral-ruleset-bundler/with-loader';

async function getDefaultRulesetFile(): Promise<Optional<string>> {
  const cwd = process.cwd();
  for (const filename of await fs.promises.readdir(cwd)) {
    if (Ruleset.isDefaultRulesetFile(filename)) {
      return path.join(cwd, filename);
    }
  }

  return;
}

export async function getRuleset(rulesetFile: Optional<string>): Promise<Ruleset> {
  if (!rulesetFile) {
    rulesetFile = await getDefaultRulesetFile();
  } else if (!path.isAbsolute(rulesetFile)) {
    rulesetFile = path.join(process.cwd(), rulesetFile);
  }

  if (!rulesetFile) {
    throw new Error(
      'No ruleset has been found. Please provide a ruleset using the spectral_ruleset option, or make sure your ruleset file matches .?spectral.(js|ya?ml|json)'
    );
  }

  info(`Loading ruleset '${rulesetFile}'...`);

  const io: IO = { fetch, fs };

  try {
    return await bundleAndLoadRuleset(rulesetFile, io, [commonjs(), builtins()]);
  } catch (e) {
    error(`Failed to load ruleset '${rulesetFile}'... Error: ${String(e)}`);
    throw e;
  }
}
