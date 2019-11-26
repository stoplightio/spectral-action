import { httpAndFileResolver } from '@stoplight/spectral/dist/resolvers/http-and-file';
import {
  Spectral,
  isJSONSchema,
  isJSONSchemaDraft4,
  isJSONSchemaDraft6,
  isJSONSchemaDraft7,
  isJSONSchemaDraft2019_09,
  isJSONSchemaLoose,
} from '@stoplight/spectral';

import { tryCatch } from 'fp-ts/lib/TaskEither';
import { toError } from 'fp-ts/lib/Either';

export const createSpectral = () => {
  return tryCatch(async () => {
    const spectral = new Spectral({ resolver: httpAndFileResolver });
    spectral.registerFormat('json-schema', isJSONSchema);
    spectral.registerFormat('json-schema-loose', isJSONSchemaLoose);
    spectral.registerFormat('json-schema-draft4', isJSONSchemaDraft4);
    spectral.registerFormat('json-schema-draft6', isJSONSchemaDraft6);
    spectral.registerFormat('json-schema-draft7', isJSONSchemaDraft7);
    spectral.registerFormat('json-schema-2019-09', isJSONSchemaDraft2019_09);
    await spectral.loadRuleset('spectral:oas');
    return spectral;
  }, toError);
};

export const runSpectral = (spectral: Spectral, parsed: string) => tryCatch(() => spectral.run(parsed), toError);
