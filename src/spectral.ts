import { getRuleset } from '@stoplight/spectral/dist/cli/services/linter/utils';
import { isRuleEnabled } from '@stoplight/spectral/dist/runner';
import { httpAndFileResolver } from '@stoplight/spectral/dist/resolvers/http-and-file';
import {
  Spectral,
  isJSONSchema,
  isJSONSchemaDraft4,
  isJSONSchemaDraft6,
  isJSONSchemaDraft7,
  isJSONSchemaDraft2019_09,
  isJSONSchemaLoose,
  isOpenApiv2,
  isOpenApiv3,
} from '@stoplight/spectral';

import { tryCatch } from 'fp-ts/lib/TaskEither';
import { toError } from 'fp-ts/lib/Either';

const normalizeRulesetPath = (rulesetPath: string): [string] | undefined => {
  if (rulesetPath.length === 0) {
    info(`Loading built-in rulesets...`);
    return undefined;
  }

  info(`Loading ruleset '${rulesetPath}'...`);
  return [rulesetPath];
};

export const createSpectral = (rulesetPath: string) => {
  return tryCatch(async () => {
    const spectral = new Spectral({ resolver: httpAndFileResolver });
    spectral.registerFormat('oas2', isOpenApiv2);
    spectral.registerFormat('oas3', isOpenApiv3);
    spectral.registerFormat('json-schema', isJSONSchema);
    spectral.registerFormat('json-schema-loose', isJSONSchemaLoose);
    spectral.registerFormat('json-schema-draft4', isJSONSchemaDraft4);
    spectral.registerFormat('json-schema-draft6', isJSONSchemaDraft6);
    spectral.registerFormat('json-schema-draft7', isJSONSchemaDraft7);
    spectral.registerFormat('json-schema-2019-09', isJSONSchemaDraft2019_09);

    const normRuleSetPath = normalizeRulesetPath(rulesetPath);
    const ruleset = await getRuleset(normRuleSetPath);
    spectral.setRuleset(ruleset);

    return spectral;
  }, toError);
};

export type fileWithContent = { path: string; content: string };

export const runSpectral = (spectral: Spectral, fileDescription: fileWithContent) => {
  return tryCatch(
    () =>
      spectral.run(fileDescription.content, {
        ignoreUnknownFormat: false,
        resolve: { documentUri: fileDescription.path },
      }),
    toError
  );
};
