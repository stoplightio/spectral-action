import { OasDocument } from "./oasDocument";
import { Spectral } from "@stoplight/spectral";
import { tryCatch } from "fp-ts/lib/TaskEither";
import { toError } from "fp-ts/lib/Either";
import {
  oas2Functions,
  rules as oas2Rules
} from "@stoplight/spectral/dist/rulesets/oas2";
import {
  oas3Functions,
  rules as oas3Rules
} from "@stoplight/spectral/dist/rulesets/oas3";

export const createSpectral = (doc: "oas2" | "oas3") => {
  return tryCatch(
    async () => {
      const spectral = new Spectral();
      if (doc === "oas2") {
        spectral.addFunctions(oas2Functions());
        spectral.addRules(await oas2Rules());
      } else {
        spectral.addFunctions(oas3Functions());
        spectral.addRules(await oas3Rules());
      }
      return spectral;
    },
    e => toError(e).message
  );
};

export const runSpectral = (spectral: Spectral, parsed: OasDocument) =>
  tryCatch(() => spectral.run(parsed), e => toError(e).message);
