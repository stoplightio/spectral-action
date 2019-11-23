import { Spectral } from "@stoplight/spectral";
import { tryCatch } from "fp-ts/lib/TaskEither";
import { toError } from "fp-ts/lib/Either";

export const createSpectral = () => {
  return tryCatch(async () => {
    const spectral = new Spectral();
    await spectral.loadRuleset("spectral:oas");
    return spectral;
  }, toError);
};

export const runSpectral = (spectral: Spectral, parsed: object) =>
  tryCatch(() => spectral.run(parsed), toError);
