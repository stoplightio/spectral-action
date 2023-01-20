import * as fs from 'fs';
import * as process from 'process';
import { createRequire } from 'module';
import type { Optional } from '@stoplight/types';
import { Ruleset, RulesetDefinition } from '@stoplight/spectral-core';
import { info, error } from '@actions/core';
import { isError, isObject } from 'lodash';
import * as path from '@stoplight/path';
import { fetch } from '@stoplight/spectral-runtime';
import { migrateRuleset, isBasicRuleset } from '@stoplight/spectral-ruleset-migrator';
import { bundleRuleset } from '@stoplight/spectral-ruleset-bundler';
import { node } from '@stoplight/spectral-ruleset-bundler/presets/node';
import { builtins } from '@stoplight/spectral-ruleset-bundler/plugins/builtins';
import { commonjs } from '@stoplight/spectral-ruleset-bundler/plugins/commonjs';
import { stdin } from '@stoplight/spectral-ruleset-bundler/plugins/stdin';

async function getDefaultRulesetFile(): Promise<Optional<string>> {
  const cwd = process.cwd();
  for (const filename of await fs.promises.readdir(cwd)) {
    if (Ruleset.isDefaultRulesetFile(filename)) {
      return path.join(cwd, filename);
    }
  }

  return;
}

function isErrorWithCode(error: Error | (Error & { code: unknown })): error is Error & { code: string } {
  return 'code' in error && typeof error.code === 'string';
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

  let ruleset: string;

  try {
    if (await isBasicRuleset(rulesetFile)) {
      const migratedRuleset = await migrateRuleset(rulesetFile, {
        format: 'esm',
        fs,
      });

      rulesetFile = path.join(path.dirname(rulesetFile), '.spectral.js');

      ruleset = await bundleRuleset(rulesetFile, {
        target: 'node',
        format: 'commonjs',
        plugins: [stdin(migratedRuleset, rulesetFile), builtins(), commonjs(), ...node({ fs, fetch })],
      });
    } else {
      ruleset = await bundleRuleset(rulesetFile, {
        target: 'node',
        format: 'commonjs',
        plugins: [builtins(), commonjs(), ...node({ fs, fetch })],
      });
    }

    return new Ruleset(load(ruleset, rulesetFile), {
      severity: 'recommended',
      source: rulesetFile,
    });
  } catch (e) {
    if (!isError(e) || !isErrorWithCode(e) || e.code !== 'UNRESOLVED_ENTRY') {
      error(`Could not load ${rulesetFile} ruleset`);
    } else {
      error(`Could not load ${rulesetFile} ruleset. ${e.message}`);
    }

    throw e;
  }
}

function load(source: string, uri: string): RulesetDefinition {
  const actualUri = path.isURL(uri) ? uri.replace(/^https?:\//, '') : uri;
  // we could use plain `require`, but this approach has a number of benefits:
  // - it is bundler-friendly
  // - ESM compliant
  // - and we have no warning raised by pkg.
  const req = createRequire(actualUri);
  const m: { exports?: RulesetDefinition } = {};
  const paths = [path.dirname(uri), __dirname];

  const _require = (id: string): unknown => req(req.resolve(id, { paths }));

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  Function('module, require', source)(m, _require);

  if (!isObject(m.exports)) {
    throw new Error('No valid export found');
  }

  return m.exports;
}
