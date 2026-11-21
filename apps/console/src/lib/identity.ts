import * as Schema from "effect/Schema";

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
    const message =
      typeof said === "object" &&
      said !== null &&
      "message" in said &&
      typeof said.message === "string"
        ? said.message
        : `It answered ${answer.status}`;
    throw new Error(message);
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
