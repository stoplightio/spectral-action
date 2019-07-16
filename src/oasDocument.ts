import * as t from "io-ts";

export const OasDocument = t.partial({
  swagger: t.string,
  openapi: t.string
});

export type OasDocument = t.TypeOf<typeof OasDocument>;
