import { passkey } from "@better-auth/passkey";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { APIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { twoFactor } from "better-auth/plugins/two-factor";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { Pool } from "pg";
import { AccountsStore } from "../accounts/store.ts";
import { EmailTaken, PersonNotFound } from "../errors.ts";
import { anonymous } from "../events/schemas.ts";
import { Events } from "../events/service.ts";
import { type ActiveProvider, Providers } from "../providers/service.ts";
import * as Secrets from "../secrets.ts";
import { Settings } from "../settings/service.ts";
import { Vault } from "../vault/service.ts";
import { Identity, type Person, type SignInMethods } from "./service.ts";

const PATH = "/api/auth" as const;
/** Nobody makes themselves a person: an admin makes people, each of whom sets a password. */
const SIGN_UP = `${PATH}/sign-up/`;
/** The route of better-auth's own an admin's making of a person goes through. */
const MADE_BY_ADMIN = "/sign-up/email";
const NOT_FOUND = 404;
/** What a person's password is kept under, among what they sign in with. */
const PASSWORD = "credential";
/** What an authenticator shows its codes under. */
const ISSUER = "Aperture";
/** The header better-auth is told where a request came from in. */
const FROM_HEADER = "x-aperture-client-address";
/** The route of better-auth's own a provider sends people back to. */
const PROVIDER_CALLBACK = "/callback/:id";
/**
 * The routes that sign someone in, each with what they prove themselves by there. A
 * password that is followed by a second factor signs nobody in yet.
 */
const SIGN_INS: ReadonlyArray<readonly [RegExp, "password" | "two_factor" | "passkey"]> = [
  [/\/sign-in\/email$/u, "password"],
  [/\/two-factor\/verify-[a-z-]+$/u, "two_factor"],
  [/\/passkey\/verify-authentication$/u, "passkey"],
];
const PROVIDER_CAME_BACK = /\/callback\/([^/]+)$/u;
/** The routes that go through a provider: they are answered by the providers there are now. */
const THROUGH_PROVIDER = /\/(sign-in\/social|link-social|callback\/[^/]+)$/u;
/**
 * How long the providers are waited for to say how they are reached, before people are
 * signed in without the ones that did not: what signs people in asks them all first.
 */
const PROVIDERS_WITHIN = "10 seconds";
/** How long they are left alone once they did not: nobody waits on them again meanwhile. */
const ASKED_AGAIN_AFTER_MILLIS = 30_000;
/** What the providers an admin added are asked how they are reached with. */
const DISCOVERY_HEADERS = { accept: "application/json" };
const REDIRECTS_FROM = 300;
const ERRORS_FROM = 400;

/** What someone who signs in with a password sends, of which the address alone is read. */
const Tried = Schema.fromJsonString(Schema.Struct({ email: Schema.optional(Schema.String) }));
/** What a route that signs someone in answers, as far as it tells whether it did and whom. */
const Answered = Schema.fromJsonString(
  Schema.Struct({
    twoFactorRedirect: Schema.optional(Schema.Boolean),
    user: Schema.optional(Schema.Struct({ id: Schema.String })),
    session: Schema.optional(Schema.Struct({ userId: Schema.String })),
    code: Schema.optional(Schema.String),
  }),
);

/**
 * Identity by better-auth, on whatever database it is given. Everything of better-auth is
 * in this function: what it is asked, and what its answers are taken for.
 */
const make = Effect.fn("Identity.make")(function* (
  database: BetterAuthOptions["database"],
  /** Whether it is a database whose tables are brought up to date before it is asked anything. */
  migrated: boolean,
) {
  const vault = yield* Vault;
  const settings = yield* Settings;
  const accounts = yield* AccountsStore;
  const events = yield* Events;
  const providers = yield* Providers;
  const context = yield* Effect.context<Crypto.Crypto>();
  /** Setup tokens on their way: better-auth hands one to whoever sends it, which is this. */
  const sent = new Map<string, string>();

  /** Why a provider's word makes nobody a person; the code is told to the page that asked. */
  const refused = (code: string, message: string) => new APIError("FORBIDDEN", { code, message });

  const secret = yield* vault.secret("identity");

  /**
   * What better-auth is told, with the providers people sign in through. It reads them
   * once, when it is made: other providers take another of it, on the same database and
   * with the same secret, so that whoever is signed in stays so.
   */
  const optionsFor = (through: ReadonlyArray<ActiveProvider>) => {
    const byId = new Map(through.map((provider) => [provider.id, provider]));
    return {
      basePath: PATH,
      ...Option.match(settings.publicUrl, {
        onNone: () => ({}),
        onSome: (baseURL) => ({ baseURL }),
      }),
      secret,
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
        // A passkey signs a person in by itself: no code is asked after it. It is good at
        // the address people reach this program at, and where none is said, at the one a
        // request came to.
        passkey({
          rpName: ISSUER,
          ...Option.match(settings.publicUrl, {
            onNone: () => ({}),
            onSome: (url) => ({ rpID: new URL(url).hostname, origin: new URL(url).origin }),
          }),
        }),
        // No second factor is asked after a provider: who it signs in is its to prove.
        genericOAuth({
          config: through.map((provider) => ({
            providerId: provider.id,
            name: provider.name,
            clientId: provider.clientId,
            clientSecret: Redacted.value(provider.clientSecret),
            scopes: [...provider.scopes],
            disableSignUp: !provider.provision,
            ...(provider.kind === "oidc"
              ? {
                  discoveryUrl: provider.discoveryUrl,
                  // Who someone is, is read from a token: one that is not checked says nothing.
                  requireIdTokenVerification: true,
                  // With headers of its own, the document is taken from where it was said to
                  // be and from nowhere another origin sends on to.
                  ...(provider.stored ? { discoveryHeaders: DISCOVERY_HEADERS } : {}),
                }
              : {
                  authorizationUrl: provider.endpoints.authorization,
                  tokenUrl: provider.endpoints.token,
                  // No token of such a provider says who someone is: it is asked with the
                  // token it gave, and an address is someone's only as it says it verified it.
                  getUserInfo: async (tokens: { readonly accessToken?: string | undefined }) => {
                    if (tokens.accessToken === undefined) {
                      return null;
                    }
                    return Option.match(
                      await Effect.runPromise(
                        providers.vouched(provider.endpoints, tokens.accessToken),
                      ),
                      { onNone: () => null, onSome: (vouched) => ({ ...vouched }) },
                    );
                  },
                }),
          })),
        }),
      ],
      // A provider signs in the person who has the address it vouches for, and no provider's
      // word is taken for an address it does not say it verified. The person's own address
      // was never verified here: an admin gave it, which is what a letter to it would show.
      account: { accountLinking: { requireLocalEmailVerified: false } },
      databaseHooks: {
        // Nobody whose account is disabled is signed in, whatever they prove themselves by.
        // It is told once they did prove it, and so to nobody else.
        session: {
          create: {
            before: async (session) => {
              const account = await Effect.runPromise(accounts.findByPerson(session.userId));
              if (Option.isSome(account) && account.value.disabledAt !== null) {
                throw refused("account_disabled", "This account is disabled. Ask an admin.");
              }
            },
            // Who a provider signed in is told nowhere but here: its answer is a redirect.
            after: async (session, context) => {
              if (context?.path !== PROVIDER_CALLBACK) {
                return;
              }
              await Effect.runPromise(
                signedIn(
                  session.userId,
                  { method: "provider", provider: String(context.params?.["id"] ?? "") },
                  Option.fromNullishOr(context.headers?.get(FROM_HEADER)),
                ),
              );
            },
          },
        },
        user: {
          create: {
            before: async (user, context) => {
              if (context?.path === MADE_BY_ADMIN) {
                return;
              }
              // Whoever else is made a person came through a provider, which says itself
              // whether it makes any, and of which domains.
              const provider = byId.get(
                String(context?.params?.["id"] ?? context?.body?.["provider"] ?? ""),
              );
              if (provider?.provision !== true) {
                throw refused("signup_disabled", "nobody is made a person by signing in");
              }
              if (user.emailVerified !== true) {
                throw refused("email_not_verified", "the provider did not verify the address");
              }
              const domain = user.email.slice(user.email.lastIndexOf("@") + 1).toLowerCase();
              if (provider.domains.length > 0 && !provider.domains.includes(domain)) {
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
  };

  /** better-auth with those providers, once it asked each of them how it is reached. */
  const ready = (through: ReadonlyArray<ActiveProvider>) =>
    Effect.promise(async () => {
      const options = optionsFor(through);
      const auth = betterAuth(options);
      await auth.$context;
      return { auth };
    });

  /** What signs people in for the providers as they are kept now, where they answer in time. */
  const read = Effect.fn(function* () {
    // Before the providers themselves: a change between the two is seen the next time.
    const revision = yield* providers.revision();
    const made = yield* ready(yield* providers.active()).pipe(
      Effect.timeoutOption(PROVIDERS_WITHIN),
    );
    return Option.map(made, (one) => ({ ...one, revision }));
  });

  if (migrated) {
    // The tables are the same whichever providers there are.
    yield* Effect.promise(async () => {
      const migrations = await getMigrations(optionsFor([]));
      await migrations.runMigrations();
    });
  }

  // A provider that does not answer holds nobody up who signs in without one: they are
  // signed in with no providers until all of them answered. No number of changes is -1,
  // so the providers are asked again when someone next comes through one.
  let current = yield* read().pipe(
    Effect.flatMap(
      Option.match({
        onSome: Effect.succeed,
        onNone: () =>
          Effect.logWarning("the providers did not answer in time: starting without them").pipe(
            Effect.andThen(ready([])),
            Effect.map((one) => ({ ...one, revision: -1 })),
          ),
      }),
    ),
  );
  const turn = yield* Semaphore.make(1);
  let askedAgainAt = 0;

  /**
   * What signs people in, for the providers as any program on this database last changed
   * them. What is being answered meanwhile is answered by what was there before.
   */
  const upToDate = Effect.fn("Identity.upToDate")(function* () {
    if ((yield* providers.revision()) === current.revision) {
      return current.auth;
    }
    return yield* turn.withPermit(
      Effect.gen(function* () {
        const moment = yield* Clock.currentTimeMillis;
        if ((yield* providers.revision()) !== current.revision && moment >= askedAgainAt) {
          const next = yield* read();
          if (Option.isSome(next)) {
            current = next.value;
          } else {
            askedAgainAt = moment + ASKED_AGAIN_AFTER_MILLIS;
            yield* Effect.logWarning(
              "the providers did not answer in time: they stay as they were for a while",
            );
          }
        }
        return current.auth;
      }),
    );
  });

  /** Records that someone signed in, as the account they sign in as where they have one. */
  const signedIn = Effect.fn(function* (
    personId: string | undefined,
    detail: { readonly method: string; readonly provider?: string },
    from: Option.Option<string>,
  ) {
    const account = personId === undefined ? Option.none() : yield* accounts.findByPerson(personId);
    yield* events.record({
      kind: "sign_in.succeeded",
      address: Option.getOrNull(from),
      detail,
      ...Option.match(account, {
        onNone: () => ({ actor: anonymous() }),
        onSome: (found) => ({
          actor: { kind: "account" as const, id: found.id, name: found.name },
          resource: { kind: "account" as const, id: found.id, label: found.name },
          ownerId: found.id,
        }),
      }),
    });
  });

  /** Records that someone did not sign in: by what they tried, and never what they tried it with. */
  const refusedSignIn = (
    detail: { readonly method: string; readonly provider?: string; readonly reason: string },
    email: string | undefined,
    from: Option.Option<string>,
  ) =>
    events.record({
      kind: "sign_in.failed",
      actor: anonymous(email ?? null),
      address: Option.getOrNull(from),
      detail,
    });

  /** Records what a request to a route that signs someone in came to. */
  const noted = Effect.fn(function* (
    path: string,
    sent: string,
    answer: Response,
    from: Option.Option<string>,
  ) {
    const provider = PROVIDER_CAME_BACK.exec(path)?.[1];
    if (provider !== undefined) {
      // Signed in, they are sent on to the console; otherwise back with why not.
      const to = answer.headers.get("location") ?? "";
      const reason =
        answer.status >= ERRORS_FROM
          ? String(answer.status)
          : answer.status >= REDIRECTS_FROM && URL.canParse(to, "http://localhost")
            ? new URL(to, "http://localhost").searchParams.get("error")
            : null;
      if (reason !== null) {
        yield* refusedSignIn({ method: "provider", provider, reason }, undefined, from);
      }
      return;
    }
    const method = SIGN_INS.find(([route]) => route.test(path))?.[1];
    if (method === undefined) {
      return;
    }
    const read = Schema.decodeUnknownOption(Answered);
    const answered = Option.getOrElse(
      read(yield* Effect.promise(() => answer.clone().text())),
      () => ({}) as typeof Answered.Type,
    );
    if (answer.ok) {
      if (answered.twoFactorRedirect !== true) {
        yield* signedIn(answered.user?.id ?? answered.session?.userId, { method }, from);
      }
      return;
    }
    const tried = Option.getOrUndefined(Schema.decodeUnknownOption(Tried)(sent));
    yield* refusedSignIn(
      { method, reason: answered.code?.toLowerCase() ?? String(answer.status) },
      tried?.email,
      from,
    );
  });

  const handle = Effect.fn("Identity.handle")(function* (
    request: Request,
    from: Option.Option<string>,
  ) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith(SIGN_UP)) {
      return new Response(null, { status: NOT_FOUND });
    }
    // Read before it is handed on, which leaves nothing of it to read.
    const signsIn = SIGN_INS.find(([route]) => route.test(pathname))?.[1];
    const sent =
      request.method === "POST" && signsIn !== undefined
        ? yield* Effect.promise(() => request.clone().text())
        : "";
    // A code is also asked of someone who is signed in, when they turn the second factor
    // on: that signs nobody in.
    const already =
      signsIn === "two_factor" && Option.isSome(yield* personOf(new Headers(request.headers)));
    // Where it came from is said here and by nobody else: what the request says of that
    // itself is dropped.
    const headers = new Headers(request.headers);
    headers.delete(FROM_HEADER);
    if (Option.isSome(from)) {
      headers.set(FROM_HEADER, from.value);
    }
    const auth = THROUGH_PROVIDER.test(pathname) ? yield* upToDate() : current.auth;
    const answer = yield* Effect.promise(() => auth.handler(new Request(request, { headers })));
    if (!already) {
      yield* noted(pathname, sent, answer, from);
    }
    return answer;
  });

  const offered = Effect.fn("Identity.providers")(function* () {
    // Those of the settings come first, and one of them stands for any other by its id.
    const enabled = (yield* providers.list()).filter((provider) => provider.enabled);
    return Arr.dedupeWith(enabled, (one, other) => one.id === other.id).map(({ id, name }) => ({
      id,
      name,
    }));
  });

  const personOf = Effect.fn("Identity.personOf")(function* (headers: Headers) {
    const session = yield* Effect.tryPromise(() => current.auth.api.getSession({ headers })).pipe(
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
      (await current.auth.$context).internalAdapter.findUserByEmail(person.email),
    );
    if (taken !== null) {
      return yield* new EmailTaken({ email: person.email });
    }
    const password = yield* Secrets.make("unset");
    const made = yield* Effect.promise(() =>
      current.auth.api.signUpEmail({ body: { ...person, password } }),
    );
    // Made with a password since nobody is made without, which is then nobody's: a
    // person has one once they set it.
    yield* Effect.promise(async () =>
      (await current.auth.$context).adapter.deleteMany({
        model: "account",
        where: [
          { field: "userId", value: made.user.id },
          { field: "providerId", value: PASSWORD },
        ],
      }),
    );
    return { id: made.user.id, email: made.user.email, name: made.user.name } satisfies Person;
  }, Effect.provide(context));

  const setupToken = Effect.fn("Identity.setupToken")(function* (email: string) {
    sent.delete(email);
    // It answers alike whether or not there is such a person, and sends a token to one there is.
    yield* Effect.tryPromise(() => current.auth.api.requestPasswordReset({ body: { email } })).pipe(
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
      (await current.auth.$context).internalAdapter.findUserByEmail(email),
    );
    if (found === null) {
      return yield* new PersonNotFound({ email });
    }
    yield* Effect.promise(async () => {
      const { adapter, internalAdapter } = await current.auth.$context;
      await adapter.deleteMany({
        model: "twoFactor",
        where: [{ field: "userId", value: found.user.id }],
      });
      await internalAdapter.updateUser(found.user.id, { twoFactorEnabled: false });
    });
  });

  const Counted = Schema.Array(Schema.Struct({ userId: Schema.String }));
  const Proven = Schema.Array(Schema.Struct({ userId: Schema.String, providerId: Schema.String }));
  const People = Schema.Array(
    Schema.Struct({
      id: Schema.String,
      email: Schema.String,
      twoFactorEnabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
    }),
  );

  const methods = Effect.fn("Identity.methods")(function* () {
    const { people, proven, passkeys } = yield* Effect.promise(async () => {
      const { adapter } = await current.auth.$context;
      return {
        people: await adapter.findMany({ model: "user" }),
        proven: await adapter.findMany({ model: "account" }),
        passkeys: await adapter.findMany({ model: "passkey" }),
      };
    });
    // A provider that was disabled or removed took nobody with it: who came through it
    // is still told to have, and that it signs nobody in now.
    const named = new Map(
      (yield* providers.list()).map(({ id, name, enabled }) => [
        id,
        enabled ? name : `${name} (disabled)`,
      ]),
    );
    const theirs = Arr.groupBy(
      yield* Effect.orDie(Schema.decodeUnknownEffect(Proven)(proven)),
      (one) => one.userId,
    );
    const held = Arr.groupBy(
      yield* Effect.orDie(Schema.decodeUnknownEffect(Counted)(passkeys)),
      (one) => one.userId,
    );
    return new Map(
      (yield* Effect.orDie(Schema.decodeUnknownEffect(People)(people))).map((person) => {
        const ways = (theirs[person.id] ?? []).map((one) => one.providerId);
        return [
          person.email,
          {
            password: ways.includes(PASSWORD),
            secondFactor: person.twoFactorEnabled === true,
            passkeys: held[person.id]?.length ?? 0,
            providers: ways
              .filter((way) => way !== PASSWORD)
              .map((way) => named.get(way) ?? `${way} (removed)`)
              .toSorted((one, other) => one.localeCompare(other)),
          } satisfies SignInMethods,
        ] as const;
      }),
    );
  });

  const signOut = Effect.fn("Identity.signOut")(function* (email: string) {
    const found = yield* Effect.promise(async () =>
      (await current.auth.$context).internalAdapter.findUserByEmail(email),
    );
    if (found === null) {
      return yield* new PersonNotFound({ email });
    }
    yield* Effect.promise(async () =>
      (await current.auth.$context).internalAdapter.deleteUserSessions(found.user.id),
    );
  });

  const remove = Effect.fn("Identity.remove")(function* (email: string) {
    const found = yield* Effect.promise(async () =>
      (await current.auth.$context).internalAdapter.findUserByEmail(email),
    );
    if (found === null) {
      return yield* new PersonNotFound({ email });
    }
    yield* Effect.promise(async () => {
      const { adapter, internalAdapter } = await current.auth.$context;
      // What plugins keep of a person is not removed with them where nothing ties the two.
      for (const model of ["twoFactor", "passkey"]) {
        await adapter.deleteMany({ model, where: [{ field: "userId", value: found.user.id }] });
      }
      await internalAdapter.deleteUser(found.user.id);
    });
  });

  const removePasskeys = Effect.fn("Identity.removePasskeys")(function* (email: string) {
    const found = yield* Effect.promise(async () =>
      (await current.auth.$context).internalAdapter.findUserByEmail(email),
    );
    if (found === null) {
      return yield* new PersonNotFound({ email });
    }
    yield* Effect.promise(async () => {
      const { adapter } = await current.auth.$context;
      await adapter.deleteMany({
        model: "passkey",
        where: [{ field: "userId", value: found.user.id }],
      });
    });
  });

  return Identity.of({
    path: PATH,
    providers: offered,
    handle,
    personOf,
    create,
    methods,
    signOut,
    remove,
    setupToken,
    resetSecondFactor,
    removePasskeys,
  });
});

/** Identity kept in the database the settings name, with its tables brought up to date first. */
export const makeIdentity = Effect.fn("Identity.makeSql")(function* () {
  const settings = yield* Settings;
  const pool = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const made = new Pool({ connectionString: Redacted.value(settings.databaseUrl) });
      // The database ends the connections that rest when it restarts: the pool drops such
      // a one and makes another when it is asked for. Unheard, Node ends the program for it.
      made.on("error", (error) => {
        Effect.runFork(Effect.logWarning("a database connection at rest was lost", error));
      });
      return made;
    }),
    (pool) => Effect.promise(() => pool.end()),
  );
  return yield* make(pool, true);
});

/** Identity kept in memory, which is gone with the layer. */
export const makeIdentityMemory = Effect.fn("Identity.makeMemory")(function* () {
  return yield* make(
    memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
      twoFactor: [],
      passkey: [],
    }),
    false,
  );
});

export const layer = Layer.effect(Identity, makeIdentity());

export const layerTest = Layer.effect(Identity, makeIdentityMemory());
