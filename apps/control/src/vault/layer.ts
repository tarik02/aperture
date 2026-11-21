import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { MasterKeyUnusable, Unsealable } from "../errors.ts";
import { Settings } from "../settings/service.ts";
import { Vault } from "./service.ts";

/** Fewer bytes than this are guessed sooner than the key made of them is broken. */
const MASTER_KEY_BYTES = 32;
const NONCE_BYTES = 12;
/** What is sealed says how, so that another way may come after this one. */
const VERSION = "v1";
/** The master key is for more than the vault; each use has a key of its own made of it. */
const PURPOSE = "aperture-control/vault/v1";

const bytes = (text: string) => new TextEncoder().encode(text);

/** The master key, as the settings name its file: whatever it holds, less the space around. */
const readMasterKey = Effect.fn("Vault.readMasterKey")(function* () {
  const settings = yield* Settings;
  const fs = yield* FileSystem.FileSystem;
  const file = settings.masterKeyFile;
  const read = yield* fs
    .readFileString(file)
    .pipe(Effect.mapError((error) => new MasterKeyUnusable({ file, reason: error.message })));
  const key = bytes(read.trim());
  if (key.byteLength < MASTER_KEY_BYTES) {
    return yield* new MasterKeyUnusable({
      file,
      reason: `it is shorter than ${MASTER_KEY_BYTES} bytes`,
    });
  }
  return key;
});

export const makeVault = Effect.fn("Vault.make")(function* (masterKey: Uint8Array<ArrayBuffer>) {
  const random = yield* Crypto.Crypto;
  // Effect neither derives nor encrypts: the keys are the platform's own.
  const key = yield* Effect.promise(async () =>
    crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: bytes(PURPOSE) },
      await crypto.subtle.importKey("raw", masterKey, "HKDF", false, ["deriveKey"]),
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    ),
  );

  const seal = Effect.fn("Vault.seal")(function* (secret: string, of: string) {
    const nonce = new Uint8Array(yield* Effect.orDie(random.randomBytes(NONCE_BYTES)));
    const sealed = yield* Effect.promise(() =>
      crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: bytes(of) },
        key,
        bytes(secret),
      ),
    );
    return [VERSION, Base64Url.encode(nonce), Base64Url.encode(new Uint8Array(sealed))].join(".");
  });

  const open = Effect.fn("Vault.open")(function* (sealed: string, of: string) {
    const [version, nonce, body] = sealed.split(".");
    if (version !== VERSION || nonce === undefined || body === undefined) {
      return yield* new Unsealable({ of, reason: "it is not sealed as this program seals" });
    }
    const unreadable = () => new Unsealable({ of, reason: "it is not written as a sealed secret" });
    const iv = yield* Effect.fromResult(Base64Url.decode(nonce)).pipe(Effect.mapError(unreadable));
    const data = yield* Effect.fromResult(Base64Url.decode(body)).pipe(Effect.mapError(unreadable));
    const opened = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.decrypt(
          { name: "AES-GCM", iv: new Uint8Array(iv), additionalData: bytes(of) },
          key,
          new Uint8Array(data),
        ),
      catch: () =>
        new Unsealable({ of, reason: "it was sealed with another master key, or for another" }),
    });
    return new TextDecoder().decode(opened);
  });

  return Vault.of({ seal, open });
});

export const layer = Layer.effect(Vault, Effect.flatMap(readMasterKey(), makeVault));
