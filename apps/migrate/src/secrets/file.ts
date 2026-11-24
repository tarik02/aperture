import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { SecretsFileUnusable } from "../errors.ts";
import { type Reissued, TokenSecrets } from "./service.ts";

/** A line of the secrets file. */
export const Line = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.String,
    account: Schema.String,
    name: Schema.String,
    secret: Schema.String,
  }),
);

/** Only whoever runs the program reads it. */
const MODE = 0o600;

/**
 * The secrets in a file, a line of JSON for each. A line is written before its token is
 * kept, so no token is ever there without its secret; a move that is cut short between
 * the two leaves a line for a token that is not, which is good for nothing.
 */
export const makeTokenSecrets = Effect.fn("TokenSecrets.make")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;

  const keep = Effect.fn("TokenSecrets.keep")(function* (token: Reissued) {
    const line = yield* Schema.encodeEffect(Line)(token).pipe(Effect.orDie);
    yield* fs
      .writeFileString(file, `${line}\n`, { flag: "a", mode: MODE })
      .pipe(Effect.mapError((error) => new SecretsFileUnusable({ file, reason: error.message })));
  });

  return TokenSecrets.of({ keep });
});

export const layer = (file: string) => Layer.effect(TokenSecrets, makeTokenSecrets(file));

/** For a move that makes no tokens: no file was named. */
export const layerNone = Layer.succeed(
  TokenSecrets,
  TokenSecrets.of({
    keep: () =>
      Effect.fail(new SecretsFileUnusable({ file: "--secrets-file", reason: "none was named" })),
  }),
);
