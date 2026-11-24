import { passkeyClient } from "@better-auth/passkey/client";
import {
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
  WebAuthnError,
} from "@simplewebauthn/browser";
import { createAuthClient } from "better-auth/client";
import { twoFactorClient } from "better-auth/client/plugins";
import { sentence } from "#/lib/words.ts";

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

/**
 * What signs people in and out, as a browser asks it. Its cookies are the browser's to
 * carry. What an authenticator is asked goes to it as it was answered, with nothing left out.
 */
export const identity = createAuthClient({ plugins: [twoFactorClient(), passkeyClient()] });

interface Refused {
  readonly status: number;
  readonly code?: string | undefined;
  readonly message?: string | undefined;
}

interface Answer<A> {
  readonly data: A | null;
  readonly error: Refused | null;
}

/** What was answered, which may be nothing, or the refusal in words of this page's own. */
const answered = async <A>(asked: Promise<Answer<A>>) => {
  const { data, error } = await asked;
  if (error !== null) {
    throw new Error(
      REFUSALS[error.code ?? ""] ??
        (error.status === TOO_MANY
          ? "Too many tries. Try again later."
          : sentence(error.message ?? `It answered ${error.status}`)),
    );
  }
  return data;
};

/** What was answered, where an answer is something. */
const said = async <A>(asked: Promise<Answer<A>>) => {
  const data = await answered(asked);
  if (data === null) {
    throw new Error("It answered nothing.");
  }
  return data;
};

/**
 * Signs in with a password. Whoever turned a second factor on is not signed in by it alone:
 * a code is asked for then, and the browser carries what says whose code it is.
 */
export const signIn = async (email: string, password: string) => {
  const signed = await said(identity.signIn.email({ email, password }));
  return "twoFactorRedirect" in signed && signed.twoFactorRedirect === true
    ? "second-factor"
    : "signed-in";
};

export const signOut = () => said(identity.signOut());

/** Sets a password with the token of a setup link. */
export const setPassword = (token: string, newPassword: string) =>
  said(identity.resetPassword({ token, newPassword }));

/** Who the browser's cookies sign in, and whether they turned a second factor on; nobody without. */
export const person = async () => {
  const session = await answered(identity.getSession());
  return session === null
    ? null
    : {
        email: session.user.email,
        name: session.user.name,
        secondFactor: session.user.twoFactorEnabled === true,
      };
};

/** Who is signed in, as a person. */
export type Person = NonNullable<Awaited<ReturnType<typeof person>>>;

/**
 * Starts turning a second factor on: what an authenticator is set up with, and the backup
 * codes. Nothing is on until a code of the authenticator's is given.
 */
export const enrol = async (password: string) => {
  const started = await said(identity.twoFactor.enable({ password }));
  if (started.method !== "totp") {
    throw new Error("It set up no authenticator.");
  }
  return {
    uri: started.totpURI,
    secret: new URL(started.totpURI).searchParams.get("secret") ?? "",
    backupCodes: started.backupCodes,
  };
};

/** Gives an authenticator's code: to finish signing in, or to finish turning the second factor on. */
export const giveCode = (code: string) => said(identity.twoFactor.verifyTotp({ code }));

/** Finishes signing in with a backup code, which is spent by it. */
export const giveBackupCode = (code: string) => said(identity.twoFactor.verifyBackupCode({ code }));

/** Makes new backup codes, in place of the ones there were: those sign nobody in any more. */
export const renewBackupCodes = async (password: string) =>
  (await said(identity.twoFactor.generateBackupCodes({ password }))).backupCodes;

export const turnSecondFactorOff = (password: string) =>
  said(identity.twoFactor.disable({ password }));

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
      optionsJSON: await said(identity.passkey.generateAuthenticateOptions()),
      useBrowserAutofill: offered,
    });
  const response = await (offered ? picked().catch(() => undefined) : picked());
  if (response === undefined) {
    return "not-signed-in";
  }
  await said(identity.passkey.verifyAuthentication({ response }));
  return "signed-in";
};

interface Kept {
  readonly id: string;
  readonly name?: string | null | undefined;
  readonly createdAt?: Date | string | null | undefined;
}

const kept = (passkey: Kept) => ({
  id: passkey.id,
  name: passkey.name?.trim() || "Passkey",
  createdAt: passkey.createdAt == null ? undefined : new Date(passkey.createdAt),
});

/** A passkey of whoever is signed in. */
export type Passkey = ReturnType<typeof kept>;

export const passkeys = async () =>
  (await said(identity.passkey.listUserPasskeys()))
    .map(kept)
    .toSorted((one, other) => (one.createdAt?.getTime() ?? 0) - (other.createdAt?.getTime() ?? 0));

/** Has an authenticator make a passkey, which is kept under the name. */
export const addPasskey = async (name: string) => {
  const making = await said(identity.passkey.generateRegisterOptions());
  const response = await startRegistration({ optionsJSON: making }).catch((error: unknown) => {
    throw error instanceof WebAuthnError &&
      error.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED"
      ? new Error("That authenticator has a passkey of yours already.")
      : error;
  });
  await said(identity.passkey.verifyRegistration({ response, name }));
};

export const renamePasskey = (id: string, name: string) =>
  said(identity.passkey.updatePasskey({ id, name }));

export const removePasskey = (id: string) => said(identity.passkey.deletePasskey({ id }));
