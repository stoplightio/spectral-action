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

export const createSpectral = (ruleset: string) => {
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
    await spectral.loadRuleset(ruleset);
    return spectral;
  }, toError);
};

export const runSpectral = (spectral: Spectral, parsed: string) => tryCatch(() => spectral.run(parsed), toError);
