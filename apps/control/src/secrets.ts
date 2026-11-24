import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Hex from "effect/encoding/Hex";

const SECRET_BYTES = 32;

/** A new secret that nobody guesses; the prefix tells what kind it is to whoever finds one. */
export const make = Effect.fn("Secrets.make")(function* (prefix: string) {
  const crypto = yield* Crypto.Crypto;
  const bytes = yield* Effect.orDie(crypto.randomBytes(SECRET_BYTES));
  return `${prefix}_${Base64Url.encode(bytes)}`;
});

/**
 * What is kept of a secret in place of it. A plain digest is enough: the secrets are
 * random and long, so there is nothing to guess them from.
 */
export const hash = Effect.fn("Secrets.hash")(function* (secret: string) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* Effect.orDie(crypto.digest("SHA-256", new TextEncoder().encode(secret)));
  return Hex.encode(digest);
});

/**
 * Whether two digests are one, in a time that says nothing of where they part. Digests
 * of one kind are of one length, which is no secret.
 */
export const same = (one: string, other: string) => {
  let parted = one.length ^ other.length;
  for (let at = 0; at < one.length; at += 1) {
    parted |= one.charCodeAt(at) ^ other.charCodeAt(at % (other.length || 1));
  }
  return parted === 0;
};

export const id = Crypto.Crypto.use((crypto) => Effect.orDie(crypto.randomUUIDv7));
