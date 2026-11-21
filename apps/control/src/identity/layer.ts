import { betterAuth, type BetterAuthOptions } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { APIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
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
/** The route of better-auth's own an admin's making of a person goes through. */
const MADE_BY_ADMIN = "/sign-up/email";
const NOT_FOUND = 404;
/** What an authenticator shows its codes under. */
const ISSUER = "Aperture";
/** The header better-auth is told where a request came from in. */
const FROM_HEADER = "x-aperture-client-address";

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

  /** Why a provider's word makes nobody a person; the code is told to the page that asked. */
  const refused = (code: string, message: string) => new APIError("FORBIDDEN", { code, message });

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
    plugins: [
      twoFactor({ issuer: ISSUER }),
      // No second factor is asked after a provider: who it signs in is its to prove.
      genericOAuth({
        config: settings.providers.map((provider) => ({
          providerId: provider.id,
          name: provider.name,
          discoveryUrl: provider.discoveryUrl,
          clientId: provider.clientId,
          clientSecret: Redacted.value(provider.clientSecret),
          scopes: ["openid", "email", "profile"],
          // Who someone is, is read from a token: one that is not checked says nothing.
          requireIdTokenVerification: true,
          disableSignUp: !settings.provisionPeople,
        })),
      }),
    ],
    // A provider signs in the person who has the address it vouches for, and no provider's
    // word is taken for an address it does not say it verified. The person's own address
    // was never verified here: an admin gave it, which is what a letter to it would show.
    account: { accountLinking: { requireLocalEmailVerified: false } },
    databaseHooks: {
      user: {
        create: {
          before: async (user, context) => {
            if (context?.path === MADE_BY_ADMIN) {
              return;
            }
            // Whoever else is made a person came through a provider.
            if (!settings.provisionPeople) {
              throw refused("signup_disabled", "nobody is made a person by signing in");
            }
            if (user.emailVerified !== true) {
              throw refused("email_not_verified", "the provider did not verify the address");
            }
            const domain = user.email.slice(user.email.lastIndexOf("@") + 1).toLowerCase();
            if (
              settings.provisionDomains.length > 0 &&
              !settings.provisionDomains.includes(domain)
            ) {
              throw refused("email_domain_refused", "people of that domain are not made here");
            }
          },
        },
      },
    },
    rateLimit: { enabled: settings.rateLimit },
    advanced: { ipAddress: { ipAddressHeaders: [FROM_HEADER] } },
    telemetry: { enabled: false },
  } satisfies BetterAuthOptions;
  const auth = betterAuth(options);

  const handle = Effect.fn("Identity.handle")(function* (
    request: Request,
    from: Option.Option<string>,
  ) {
    if (new URL(request.url).pathname.startsWith(SIGN_UP)) {
      return new Response(null, { status: NOT_FOUND });
    }
    // Where it came from is said here and by nobody else: what the request says of that
    // itself is dropped.
    const headers = new Headers(request.headers);
    headers.delete(FROM_HEADER);
    if (Option.isSome(from)) {
      headers.set(FROM_HEADER, from.value);
    }
    return yield* Effect.promise(() => auth.handler(new Request(request, { headers })));
  });

  const providers = Effect.fn("Identity.providers")(() =>
    Effect.succeed(settings.providers.map(({ id, name }) => ({ id, name }))),
  );

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

  const resetSecondFactor = Effect.fn("Identity.resetSecondFactor")(function* (email: string) {
    const found = yield* Effect.promise(async () =>
      (await auth.$context).internalAdapter.findUserByEmail(email),
    );
    if (found === null) {
      return yield* new PersonNotFound({ email });
    }
    yield* Effect.promise(async () => {
      const { adapter, internalAdapter } = await auth.$context;
      await adapter.deleteMany({
        model: "twoFactor",
        where: [{ field: "userId", value: found.user.id }],
      });
      await internalAdapter.updateUser(found.user.id, { twoFactorEnabled: false });
    });
  });

  return {
    auth,
    options,
    service: Identity.of({
      path: PATH,
      providers,
      handle,
      personOf,
      create,
      setupToken,
      resetSecondFactor,
    }),
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
