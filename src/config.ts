import * as t from 'io-ts';

export const Config = t.strict({
  GITHUB_EVENT_PATH: t.string,
  INPUT_REPO_TOKEN: t.string,
  GITHUB_WORKSPACE: t.string,
  INPUT_FILE_GLOB: t.string,
  GITHUB_ACTION: t.string,
  INPUT_SPECTRAL_RULESET: t.string,
});

export type Config = t.TypeOf<typeof Config>;
