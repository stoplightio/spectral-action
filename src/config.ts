import * as D from 'io-ts/lib/Decoder';

export const Config = D.type({
  GITHUB_EVENT_PATH: D.string,
  INPUT_REPO_TOKEN: D.string,
  GITHUB_WORKSPACE: D.string,
  INPUT_FILE_GLOB: D.string,
  INPUT_EVENT_NAME: D.string,
  INPUT_SPECTRAL_RULESET: D.string,
  INPUT_USE_NIMMA: D.bool,
});

export type Config = D.TypeOf<typeof Config>;
