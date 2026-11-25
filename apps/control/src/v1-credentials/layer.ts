// Effect's Crypto has no Argon2, and Node's has had it since 24.7.
// oxlint-disable-next-line import/no-nodejs-modules
import { argon2 } from "node:crypto";
import { compare } from "bcryptjs";
import { hashPassword, symmetricEncrypt } from "better-auth/crypto";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { NewApiToken } from "../accounts/store.ts";
import { AccountsStore } from "../accounts/store.ts";
import * as Secrets from "../secrets.ts";
import { done, first, one } from "../store/rows.ts";
import { now } from "../time.ts";
import { Vault } from "../vault/service.ts";
import { V1Credentials } from "./service.ts";

/** A token of v1: `apt_`, its id, and its secret, which may have underscores of its own. */
const TOKEN = /^apt_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_(.+)$/u;
/** What a token of v1 is kept under in `api_tokens` until it is first used: no SHA-256 in hex has a colon. */
const unconverted = (id: string) => `v1:${id}`;
/** A digest of v1's password, as its Argon2 library wrote it: base64 without padding. */
const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/u;
/** What better-auth keeps a person's password under, among what they sign in with. */
const PASSWORD = "credential";
/** How better-auth's second factor is told that a secret is in base32, as it came from elsewhere. */
const BASE32 = "base32:";

/** Bytes of base64 as v1's Argon2 library wrote it, without the padding. */
const bytesOf = (unpadded: string) =>
  Result.getOrUndefined(Base64.decode(unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, "=")));

const derive = (parameters: Parameters<typeof argon2>[1]) =>
  Effect.callback<Uint8Array, Error>((resume) => {
    argon2("argon2id", parameters, (error, key) => {
      resume(error === null ? Effect.succeed(key) : Effect.fail(error));
    });
  });

const Digest = Schema.Struct({ digest: Schema.String });
const Person = Schema.Struct({ personId: Schema.NullOr(Schema.String) });
const Counts = Schema.Struct({ tokens: Schema.Number, passwords: Schema.Number });

export const makeV1Credentials = Effect.fn("V1Credentials.make")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const accounts = yield* AccountsStore;
  const crypto = yield* Effect.context<Crypto.Crypto>();

  const keepToken = Effect.fn("V1Credentials.keepToken")(function* (
    token: Omit<NewApiToken, "tokenHash">,
    digest: string,
  ) {
    const kept = yield* accounts.insertToken({ ...token, tokenHash: unconverted(token.id) });
    yield* done(sql`INSERT INTO v1_api_tokens (token_id, digest) VALUES (${token.id}, ${digest})`);
    return kept;
  });

  const keepSignIn = Effect.fn("V1Credentials.keepSignIn")(function* (
    accountId: string,
    kept: { readonly password: string | null; readonly secondFactor: string | null },
  ) {
    const { personId } = yield* sql`SELECT person_id FROM accounts WHERE id = ${accountId}`.pipe(
      one(Person),
    );
    if (personId === null) {
      return;
    }
    const at = yield* now;
    if (kept.password !== null) {
      yield* done(sql`
          INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
          VALUES (${yield* Secrets.id}, ${personId}, ${PASSWORD}, ${personId}, ${kept.password}, ${at}, ${at})
        `);
    }
    if (kept.secondFactor !== null) {
      // What better-auth seals a second factor's secret with.
      const identity = yield* (yield* Vault).secret("identity");
      const secret = yield* Effect.promise(() =>
        symmetricEncrypt({ key: identity, data: `${BASE32}${kept.secondFactor}` }),
      );
      // v1 kept no backup codes v2 could check: whoever wants some makes new ones.
      const backupCodes = yield* Effect.promise(() =>
        symmetricEncrypt({ key: identity, data: "[]" }),
      );
      yield* done(sql`
          INSERT INTO "twoFactor" (id, secret, "backupCodes", "userId", verified)
          VALUES (${yield* Secrets.id}, ${secret}, ${backupCodes}, ${personId}, true)
        `);
      yield* done(sql`UPDATE "user" SET "twoFactorEnabled" = true WHERE id = ${personId}`);
    }
  }, Effect.provide(crypto));

  const convertToken = Effect.fn("V1Credentials.convertToken")(function* (bearer: string) {
    const [, id, secret] = TOKEN.exec(bearer) ?? [];
    if (id === undefined || secret === undefined) {
      return;
    }
    const kept = yield* sql`SELECT digest FROM v1_api_tokens WHERE token_id = ${id}`.pipe(
      first(Digest),
    );
    if (Option.isNone(kept) || !(yield* Effect.promise(() => compare(secret, kept.value.digest)))) {
      return;
    }
    const hashed = yield* Secrets.hash(bearer);
    // Two first uses at once both get here, and the second changes nothing.
    yield* Effect.all([
      done(sql`
          UPDATE api_tokens SET token_hash = ${hashed}
          WHERE id = ${id} AND token_hash = ${unconverted(id)}
        `),
      done(sql`DELETE FROM v1_api_tokens WHERE token_id = ${id}`),
    ]).pipe(sql.withTransaction, Effect.orDie);
  }, Effect.provide(crypto));

  const checkPassword = Effect.fn("V1Credentials.checkPassword")(function* (
    digest: string,
    password: string,
  ) {
    const [, memory, passes, parallelism, salt = "", hash = ""] = PHC.exec(digest) ?? [];
    const nonce = bytesOf(salt);
    const expected = bytesOf(hash);
    if (nonce === undefined || expected === undefined || expected.length === 0) {
      return false;
    }
    const derived = yield* derive({
      message: password,
      nonce,
      memory: Number(memory),
      passes: Number(passes),
      parallelism: Number(parallelism),
      tagLength: expected.length,
    }).pipe(Effect.option);
    // Compared as digests are, in a time that says nothing of where they part.
    if (Option.isNone(derived) || !Secrets.same(Hex.encode(derived.value), Hex.encode(expected))) {
      return false;
    }
    const replaced = yield* Effect.promise(() => hashPassword(password));
    // Each digest has a salt of its own, so it is one person's.
    yield* done(sql`
      UPDATE account SET password = ${replaced}, "updatedAt" = ${yield* now}
      WHERE password = ${digest} AND "providerId" = ${PASSWORD}
    `);
    return true;
  });

  const unconvertedCounts = Effect.fn("V1Credentials.unconverted")(function* () {
    const at = yield* now;
    return yield* sql`
      SELECT
        (SELECT count(*)::int FROM v1_api_tokens
          JOIN live_api_tokens AS api_tokens ON api_tokens.id = v1_api_tokens.token_id
          WHERE api_tokens.revoked_at IS NULL
            AND (api_tokens.expires_at IS NULL OR api_tokens.expires_at > ${at})) AS tokens,
        (SELECT count(*)::int FROM account
          WHERE "providerId" = ${PASSWORD} AND password LIKE ${"$argon2id$%"}) AS passwords
    `.pipe(one(Counts));
  });

  return V1Credentials.of({
    keepToken,
    keepSignIn,
    convertToken,
    checkPassword,
    unconverted: unconvertedCounts,
  });
});

export const layer = Layer.effect(V1Credentials, makeV1Credentials());

/**
 * Tells in the log, when the control plane starts, how much of v1 is still kept as v1 kept
 * it: once nothing is, what keeps it can go.
 */
export const announce = Layer.effectDiscard(
  Effect.gen(function* () {
    const { tokens, passwords } = yield* (yield* V1Credentials).unconverted();
    if (tokens + passwords > 0) {
      yield* Effect.logInfo(
        `kept as Aperture v1 kept them, until they are first used: ${tokens} API tokens, ${passwords} passwords`,
      );
    }
  }),
);
