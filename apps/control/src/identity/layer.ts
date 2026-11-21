import { betterAuth, type BetterAuthOptions } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { getMigrations } from "better-auth/db/migration";
import { twoFactor } from "better-auth/plugins/two-factor";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { Pool } from "pg";
import { EmailTaken, PersonNotFound } from "../errors.ts";
import * as Secrets from "../secrets.ts";
import { Settings } from "../settings/service.ts";
import { Vault } from "../vault/service.ts";
import { Identity, type Person } from "./service.ts";

const PATH = "/api/auth" as const;
/** Nobody makes themselves a person: an admin makes people, each of whom sets a password. */
const SIGN_UP = `${PATH}/sign-up/`;
const NOT_FOUND = 404;
/** What an authenticator shows its codes under. */
const ISSUER = "Aperture";

/**
 * Identity by better-auth, on whatever database it is given. Everything of better-auth is
 * in this function: what it is asked, and what its answers are taken for.
 */
const make = Effect.fn("Identity.make")(function* (database: BetterAuthOptions["database"]) {
  const vault = yield* Vault;
  const settings = yield* Settings;
  const context = yield* Effect.context<Crypto.Crypto>();
  /** Setup tokens on their way: better-auth hands one to whoever sends it, which is this. */
  const sent = new Map<string, string>();

  const options = {
    basePath: PATH,
    ...Option.match(settings.publicUrl, {
      onNone: () => ({}),
      onSome: (baseURL) => ({ baseURL }),
    }),
    secret: yield* vault.secret("identity"),
    database,
    emailAndPassword: {
      enabled: true,
      // A person is made with a password nobody knows, and sets their own.
      autoSignIn: false,
      sendResetPassword: async ({ user, token }) => {
        sent.set(user.email, token);
      },
    },
    // A second factor is a person's own to turn on, with an authenticator's codes. Its secret
    // and backup codes are kept in its own table, sealed with the secret above.
    plugins: [twoFactor({ issuer: ISSUER })],
    telemetry: { enabled: false },
  } satisfies BetterAuthOptions;
  const auth = betterAuth(options);

  const handle = Effect.fn("Identity.handle")(function* (request: Request) {
    if (new URL(request.url).pathname.startsWith(SIGN_UP)) {
      return new Response(null, { status: NOT_FOUND });
    }
    return yield* Effect.promise(() => auth.handler(request));
  });

  const personOf = Effect.fn("Identity.personOf")(function* (headers: Headers) {
    const session = yield* Effect.tryPromise(() => auth.api.getSession({ headers })).pipe(
      // Cookies that are not read sign nobody in.
      Effect.orElseSucceed(() => null),
    );
    return Option.fromNullOr(session).pipe(
      Option.map(({ user }): Person => ({ id: user.id, email: user.email, name: user.name })),
    );
  });

  const create = Effect.fn("Identity.create")(function* (person: {
    readonly email: string;
    readonly name: string;
  }) {
    // Asked first: signing up with an address that is taken is answered as if it were not,
    // so that nobody learns from it who signs in here.
    const taken = yield* Effect.promise(async () =>
      (await auth.$context).internalAdapter.findUserByEmail(person.email),
    );
    if (taken !== null) {
      return yield* new EmailTaken({ email: person.email });
    }
    const password = yield* Secrets.make("unset");
    const made = yield* Effect.promise(() =>
      auth.api.signUpEmail({ body: { ...person, password } }),
    );
    return { id: made.user.id, email: made.user.email, name: made.user.name } satisfies Person;
  }, Effect.provide(context));

  const setupToken = Effect.fn("Identity.setupToken")(function* (email: string) {
    sent.delete(email);
    // It answers alike whether or not there is such a person, and sends a token to one there is.
    yield* Effect.tryPromise(() => auth.api.requestPasswordReset({ body: { email } })).pipe(
      Effect.ignore,
    );
    const token = sent.get(email);
    sent.delete(email);
    if (token === undefined) {
      return yield* new PersonNotFound({ email });
    }
    return token;
  });

  return {
    auth,
    options,
    service: Identity.of({ path: PATH, handle, personOf, create, setupToken }),
  };
});

/** Identity kept in the database the settings name, with its tables brought up to date first. */
export const makeIdentity = Effect.fn("Identity.makeSql")(function* () {
  const settings = yield* Settings;
  const pool = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: Redacted.value(settings.databaseUrl) })),
    (pool) => Effect.promise(() => pool.end()),
  );
  const { options, service } = yield* make(pool);
  yield* Effect.promise(async () => {
    const migrations = await getMigrations(options);
    await migrations.runMigrations();
  });
  return service;
});

/** Identity kept in memory, which is gone with the layer. */
export const makeIdentityMemory = Effect.fn("Identity.makeMemory")(function* () {
  const { service } = yield* make(
    memoryAdapter({ user: [], session: [], account: [], verification: [], twoFactor: [] }),
  );
  return service;
});

export const layer = Layer.effect(Identity, makeIdentity());

export const layerTest = Layer.effect(Identity, makeIdentityMemory());
