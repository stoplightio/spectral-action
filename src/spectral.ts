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

import * as IOEither from 'fp-ts/IOEither';
import * as TE from 'fp-ts/TaskEither';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/pipeable';

import { info } from '@actions/core';
import { pluralizer } from './utils';

const evaluateNumberOfExceptions = (exceptions: Record<string, string[]>) => {
  const reduced = Object.keys(exceptions).reduce(
    (acc, cur) => {
      acc.uniqueFilePaths.add(cur.split('#')[0]);
      acc.numberOfExceptions += exceptions[cur].length;
      return acc;
    },
    { numberOfExceptions: 0, uniqueFilePaths: new Set() }
  );

  return {
    numberOfExceptions: reduced.numberOfExceptions,
    numberOfFiles: reduced.uniqueFilePaths.size,
  };
};

const normalizeRulesetPath = (rulesetPath: string): [string] | undefined => {
  if (rulesetPath.length === 0) {
    info(`Loading built-in rulesets...`);
    return undefined;
  }

  info(`Loading ruleset '${rulesetPath}'...`);
  return [rulesetPath];
};

const retrieveSpectralPackageVersion = (): IOEither.IOEither<Error, string> =>
  IOEither.tryCatch<Error, string>(() => {
    const x = require('../node_modules/@stoplight/spectral/package.json');
    return String(x.version);
  }, E.toError);

export const createSpectral = (rulesetPath: string) =>
  pipe(
    TE.fromIOEither(retrieveSpectralPackageVersion()),
    TE.chain(spectralPackageVersion =>
      TE.tryCatch(async () => {
        info(`Running Spectral v${spectralPackageVersion}`);

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
        info(`Loading ruleset '${rulesetPath}'...`);
        info(`Loading built-in rulesets...`);
        spectral.setRuleset(ruleset);

        const loadedRules = Object.values(spectral.rules);
        info(` - ${pluralizer(loadedRules.length, 'rule')} (${loadedRules.filter(isRuleEnabled).length} enabled)`);

        const exceptionsStats = evaluateNumberOfExceptions(ruleset.exceptions);
        info(
          ` - ${pluralizer(exceptionsStats.numberOfExceptions, 'exception')} (spanning ${pluralizer(
            exceptionsStats.numberOfFiles,
            'file'
          )})`
        );

        return spectral;
      }, E.toError)
    )
  );

export type fileWithContent = { path: string; content: string };

export const runSpectral = (spectral: Spectral, fileDescription: fileWithContent) => {
  return TE.tryCatch(
    () =>
      spectral.run(fileDescription.content, {
        ignoreUnknownFormat: false,
        resolve: { documentUri: fileDescription.path },
      }),
    E.toError
  );
};
