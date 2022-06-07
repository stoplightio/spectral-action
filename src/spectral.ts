import { Spectral, Document } from '@stoplight/spectral-core';
import * as Parsers from '@stoplight/spectral-parsers';
import { httpAndFileResolver } from '@stoplight/spectral-ref-resolver';
import pluralize from 'pluralize';

import * as IOEither from 'fp-ts/IOEither';
import * as TE from 'fp-ts/TaskEither';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/pipeable';

import { info, setFailed } from '@actions/core';
import { getRuleset } from './getRuleset';

const retrieveSpectralPackageVersion = (): IOEither.IOEither<Error, string> =>
  IOEither.tryCatch<Error, string>(() => {
    const x = require('../node_modules/@stoplight/spectral-core/package.json');
    return String(x.version);
  }, E.toError);

export const createSpectral = (rulesetPath: string) =>
  pipe(
    TE.fromIOEither(retrieveSpectralPackageVersion()),
    TE.chain(spectralPackageVersion =>
      TE.tryCatch(async () => {
        info(`Running @stoplight/spectral-core v${spectralPackageVersion}`);

        const spectral = new Spectral({ resolver: httpAndFileResolver });

        try {
          const ruleset = await getRuleset(rulesetPath);
          spectral.setRuleset(ruleset);
        } catch (e) {
          setFailed('Issue loading ruleset');
          throw e;
        }

        const loadedRules = Object.values(spectral.ruleset!.rules);
        info(` - ${pluralize('rule', loadedRules.length)} (${loadedRules.filter(r => r.enabled).length} enabled)`);

        return spectral;
      }, E.toError)
    )
  );

export type FileWithContent = { path: string; content: string };

export const runSpectral = (spectral: Spectral, fileDescription: FileWithContent) => {
  return TE.tryCatch(
    () =>
      spectral.run(new Document(fileDescription.content, Parsers.Yaml, fileDescription.path), {
        ignoreUnknownFormat: false,
      }),
    E.toError
  );
};
