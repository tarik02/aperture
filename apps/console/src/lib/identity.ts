import {
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
  WebAuthnError,
} from "@simplewebauthn/browser";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { sentence } from "#/lib/words.ts";

const Refused = Schema.Struct({
  code: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});

/** What is said in words of this page's own, by the code of what was answered. */
const REFUSALS: Readonly<Record<string, string>> = {
  INVALID_EMAIL_OR_PASSWORD: "Wrong email or password.",
  INVALID_PASSWORD: "Wrong password.",
  INVALID_CODE: "That code is not right.",
  INVALID_BACKUP_CODE: "That backup code is not right.",
  INVALID_TWO_FACTOR_COOKIE: "That took too long. Start over.",
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: "Too many tries. Start over.",
  INVALID_TOKEN: "This link is good no more. Ask for another.",
  PASSWORD_TOO_SHORT: "That password is too short.",
  PASSWORD_TOO_LONG: "That password is too long.",
  SESSION_NOT_FRESH: "Sign out and in again first: you signed in too long ago for this.",
  PASSKEY_NOT_FOUND: "That passkey is none of an account here.",
  CHALLENGE_NOT_FOUND: "That took too long. Try again.",
};

const TOO_MANY = 429;

/** What signs people in and out, as a browser asks it. Its cookies are the browser's to carry. */
const ask = async (path: string, body?: object): Promise<unknown> => {
  const answer = await fetch(
    `/api/auth${path}`,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const said: unknown = await answer.json().catch(() => null);
  if (!answer.ok) {
    const refused = Option.getOrUndefined(Schema.decodeUnknownOption(Refused)(said));
    throw new Error(
      REFUSALS[refused?.code ?? ""] ??
        (answer.status === TOO_MANY
          ? "Too many tries. Try again later."
          : sentence(refused?.message ?? `It answered ${answer.status}`)),
    );
  }
  return said;
};

const SignedIn = Schema.Struct({ twoFactorRedirect: Schema.optional(Schema.Boolean) });

/**
 * Signs in with a password. Whoever turned a second factor on is not signed in by it alone:
 * a code is asked for then, and the browser carries what says whose code it is.
 */
export const signIn = async (email: string, password: string) => {
  const said = Schema.decodeUnknownSync(SignedIn)(await ask("/sign-in/email", { email, password }));
  return said.twoFactorRedirect === true ? "second-factor" : "signed-in";
};

export const signOut = () => ask("/sign-out", {});

/** Sets a password with the token of a setup link. */
export const setPassword = (token: string, newPassword: string) =>
  ask("/reset-password", { token, newPassword });

const Session = Schema.NullOr(
  Schema.Struct({
    user: Schema.Struct({
      email: Schema.String,
      name: Schema.String,
      twoFactorEnabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
    }),
  }),
);

/** Who the browser's cookies sign in, and whether they turned a second factor on; nobody without. */
export const person = async () => {
  const said = Schema.decodeUnknownSync(Session)(await ask("/get-session"));
  return said === null
    ? null
    : {
        email: said.user.email,
        name: said.user.name,
        secondFactor: said.user.twoFactorEnabled === true,
      };
};

/** Who is signed in, as a person. */
export type Person = NonNullable<Awaited<ReturnType<typeof person>>>;

const Enrolment = Schema.Struct({
  totpURI: Schema.String,
  backupCodes: Schema.Array(Schema.String),
});

/**
 * Starts turning a second factor on: what an authenticator is set up with, and the backup
 * codes. Nothing is on until a code of the authenticator's is given.
 */
export const enrol = async (password: string) => {
  const said = Schema.decodeUnknownSync(Enrolment)(await ask("/two-factor/enable", { password }));
  return {
    uri: said.totpURI,
    secret: new URL(said.totpURI).searchParams.get("secret") ?? "",
    backupCodes: said.backupCodes,
  };
};

/** Gives an authenticator's code: to finish signing in, or to finish turning the second factor on. */
export const giveCode = (code: string) => ask("/two-factor/verify-totp", { code });

/** Finishes signing in with a backup code, which is spent by it. */
export const giveBackupCode = (code: string) => ask("/two-factor/verify-backup-code", { code });

const BackupCodes = Schema.Struct({ backupCodes: Schema.Array(Schema.String) });

/** Makes new backup codes, in place of the ones there were: those sign nobody in any more. */
export const renewBackupCodes = async (password: string) =>
  Schema.decodeUnknownSync(BackupCodes)(
    await ask("/two-factor/generate-backup-codes", { password }),
  ).backupCodes;

export const turnSecondFactorOff = (password: string) => ask("/two-factor/disable", { password });

const Transport = Schema.Literals([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]);
const Credential = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("public-key"),
  transports: Schema.optional(Schema.mutable(Schema.Array(Transport))),
});
const UserVerification = Schema.Literals(["discouraged", "preferred", "required"]);
const Extensions = Schema.Record(Schema.String, Schema.Unknown);

/** What an authenticator is asked to prove with a passkey it has. */
const Asked = Schema.Struct({
  challenge: Schema.String,
  timeout: Schema.optional(Schema.Number),
  rpId: Schema.optional(Schema.String),
  allowCredentials: Schema.optional(Schema.mutable(Schema.Array(Credential))),
  userVerification: Schema.optional(UserVerification),
  extensions: Schema.optional(Extensions),
});

/** What an authenticator is asked to make a passkey of. */
const Making = Schema.Struct({
  challenge: Schema.String,
  rp: Schema.Struct({ name: Schema.String, id: Schema.optional(Schema.String) }),
  user: Schema.Struct({ id: Schema.String, name: Schema.String, displayName: Schema.String }),
  pubKeyCredParams: Schema.mutable(
    Schema.Array(Schema.Struct({ type: Schema.Literal("public-key"), alg: Schema.Number })),
  ),
  timeout: Schema.optional(Schema.Number),
  excludeCredentials: Schema.optional(Schema.mutable(Schema.Array(Credential))),
  authenticatorSelection: Schema.optional(
    Schema.Struct({
      authenticatorAttachment: Schema.optional(Schema.Literals(["cross-platform", "platform"])),
      requireResidentKey: Schema.optional(Schema.Boolean),
      residentKey: Schema.optional(Schema.Literals(["discouraged", "preferred", "required"])),
      userVerification: Schema.optional(UserVerification),
    }),
  ),
  attestation: Schema.optional(Schema.Literals(["direct", "enterprise", "indirect", "none"])),
  extensions: Schema.optional(Extensions),
});

/** Whether this browser has passkeys at all. */
export const passkeysSupported = browserSupportsWebAuthn;

/** Whether this browser offers passkeys where an address is typed, beside what it remembers. */
export const passkeysOffered = browserSupportsWebAuthnAutofill;

/**
 * Whether asking for a passkey ended because it was called off: by the person, who is told
 * nothing of what they did themselves, or by another asking.
 */
export const calledOff = (error: unknown) =>
  error instanceof WebAuthnError &&
  (error.code === "ERROR_CEREMONY_ABORTED" || error.name === "NotAllowedError");

/** Calls off what an authenticator is being asked, where the page that asked is left. */
export const stopAsking = () => WebAuthnAbortService.cancelCeremony();

/**
 * Signs in with a passkey, which needs nothing after it. `offered` waits for the person to
 * pick one where they type their address: it asks nothing of them until they do, and tells
 * them nothing where none can be offered.
 */
export const signInWithPasskey = async (offered = false) => {
  const picked = async () =>
    startAuthentication({
      optionsJSON: Schema.decodeUnknownSync(Asked)(
        await ask("/passkey/generate-authenticate-options"),
      ),
      useBrowserAutofill: offered,
    });
  const response = await (offered ? picked().catch(() => undefined) : picked());
  if (response === undefined) {
    return "not-signed-in";
  }
  await ask("/passkey/verify-authentication", { response });
  return "signed-in";
};

const Passkey = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.optional(Schema.NullOr(Schema.String)),
});

const kept = (said: typeof Passkey.Type) => ({
  id: said.id,
  name: said.name?.trim() || "Passkey",
  createdAt: said.createdAt == null ? undefined : new Date(said.createdAt),
});

/** A passkey of whoever is signed in. */
export type Passkey = ReturnType<typeof kept>;

export const passkeys = async () =>
  Schema.decodeUnknownSync(Schema.Array(Passkey))(await ask("/passkey/list-user-passkeys"))
    .map(kept)
    .toSorted((one, other) => (one.createdAt?.getTime() ?? 0) - (other.createdAt?.getTime() ?? 0));

/** Has an authenticator make a passkey, which is kept under the name. */
export const addPasskey = async (name: string) => {
  const making = Schema.decodeUnknownSync(Making)(await ask("/passkey/generate-register-options"));
  const response = await startRegistration({ optionsJSON: making }).catch((error: unknown) => {
    throw error instanceof WebAuthnError &&
      error.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED"
      ? new Error("That authenticator has a passkey of yours already.")
      : error;
  });
  await ask("/passkey/verify-registration", { response, name });
};

export const renamePasskey = (id: string, name: string) =>
  ask("/passkey/update-passkey", { id, name });

export const removePasskey = (id: string) => ask("/passkey/delete-passkey", { id });
