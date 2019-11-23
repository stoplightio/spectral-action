import { Spectral } from "@stoplight/spectral";
import { httpAndFileResolver } from "@stoplight/spectral/dist/resolvers/http-and-file";
import { tryCatch } from "fp-ts/lib/TaskEither";
import { toError } from "fp-ts/lib/Either";

export const createSpectral = () => {
  return tryCatch(async () => {
    const spectral = new Spectral({ resolver: httpAndFileResolver });
    await spectral.loadRuleset("spectral:oas");
    return spectral;
  }, toError);
};

export const runSpectral = (spectral: Spectral, parsed: string) =>
  tryCatch(() => spectral.run(parsed), toError);
