import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  DiscoveryFailed,
  ProviderConfigured,
  ProviderInvalid,
  ProviderNotFound,
  ProviderTaken,
} from "../errors.ts";
import { Events } from "../events/service.ts";
import { type Provider, Settings } from "../settings/service.ts";
import { now } from "../time.ts";
import { Vault } from "../vault/service.ts";
import {
  discoveryOf,
  type Endpoints,
  type Kind,
  SCOPES,
  type StoredProvider,
  WELL_KNOWN,
} from "./schemas.ts";
import {
  type ActiveProvider,
  type Asked,
  type ChangedProvider,
  type GivenEndpoints,
  type GivenProvider,
  Providers,
  type ToldProvider,
  type Vouched,
} from "./service.ts";
import { ProvidersStore } from "./store.ts";

/** A provider that takes longer to say how it is reached keeps people waiting as long. */
const ANSWERS_WITHIN = "5 seconds";
/** Many times what any provider says of itself, and little to hold in memory. */
const DOCUMENT_BYTES = 256 * 1024;
const OK = 200;
const NOT_FOUND = 404;
const FAILED_FROM = 500;
const REDIRECTS = [301, 302, 303, 307, 308];
/** What a place that tells who someone is answers whoever brings no token. */
const ASKS_WHO = [401, 403];
/** What this program says it is, where it asks: GitHub answers nobody who does not say. */
const AGENT = "aperture-control";
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/u;

/** What a discovery document says, as far as signing people in takes it. */
const Document = Schema.fromJsonString(
  Schema.Struct({
    issuer: Schema.optional(Schema.String),
    authorization_endpoint: Schema.optional(Schema.String),
    token_endpoint: Schema.optional(Schema.String),
    jwks_uri: Schema.optional(Schema.String),
    scopes_supported: Schema.optional(Schema.Array(Schema.String)),
  }),
);

const ENDPOINTS = [
  ["authorization_endpoint", "where people are sent to sign in"],
  ["token_endpoint", "where their sign-in is exchanged for tokens"],
  ["jwks_uri", "the keys its tokens are checked against"],
] as const;

/** Where a provider that speaks OAuth 2.0 alone is asked, each with what it is for. */
const PLACES = [
  ["authorization", "Where people are sent to sign in"],
  ["token", "Where their sign-in is exchanged for a token"],
  ["userInfo", "Where a token tells who someone is"],
  ["emails", "Where a token tells someone's addresses"],
] as const;

const Id = Schema.Union([Schema.String, Schema.Number]);

/** Who a token is someone's, as a provider that speaks OAuth 2.0 alone tells it. */
const UserInfo = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optional(Schema.NullOr(Id)),
    sub: Schema.optional(Schema.NullOr(Id)),
    login: Schema.optional(Schema.NullOr(Schema.String)),
    name: Schema.optional(Schema.NullOr(Schema.String)),
    email: Schema.optional(Schema.NullOr(Schema.String)),
    email_verified: Schema.optional(Schema.NullOr(Schema.Boolean)),
  }),
);

/** Someone's addresses as GitHub lists them: one is theirs first, and each is verified or not. */
const Emails = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      email: Schema.String,
      primary: Schema.optional(Schema.NullOr(Schema.Boolean)),
      verified: Schema.optional(Schema.NullOr(Schema.Boolean)),
    }),
  ),
);

const slashless = (address: string) => address.replace(/\/+$/u, "");

/** Where a provider is asked as it is kept: without what was typed around each address. */
const endpointsOf = (given: GivenEndpoints): Endpoints => ({
  authorization: given.authorization.trim(),
  token: given.token.trim(),
  userInfo: given.userInfo.trim(),
  emails: (given.emails ?? "").trim() === "" ? null : (given.emails ?? "").trim(),
});

/** What a secret is sealed as: it opens as that provider's and no other's. */
const sealedAs = (id: string) => `provider:${id}`;

export const makeProviders = Effect.fn("Providers.make")(function* () {
  const store = yield* ProvidersStore;
  const settings = yield* Settings;
  const vault = yield* Vault;
  const events = yield* Events;
  const client = yield* HttpClient.HttpClient;

  /**
   * Why an address is none this program asks: it asks with TLS alone, but for this
   * machine itself where the settings let it, and carries nobody's password there.
   */
  const refused = (what: string, given: string) => {
    if (!URL.canParse(given)) {
      return Option.some(`${what} is not an address: ${given}`);
    }
    const url = new URL(given);
    if (url.username !== "" || url.password !== "") {
      return Option.some(`${what} must not carry a user name or a password.`);
    }
    if (url.protocol === "https:") {
      return Option.none();
    }
    if (url.protocol === "http:" && LOOPBACK.test(url.hostname) && settings.providersOnLoopback) {
      return Option.none();
    }
    return Option.some(`${what} has to be an https:// address: ${given}`);
  };

  /** What was answered, where it is no more than any document here is; or why it is not read. */
  const whole = Effect.fn("Providers.whole")(function* (
    answer: HttpClientResponse.HttpClientResponse,
  ) {
    const read = yield* answer.stream.pipe(
      Stream.mapError(() => "halted" as const),
      Stream.runFoldEffect(
        () => ({ size: 0, parts: Arr.empty<Uint8Array>() }),
        (so, part) =>
          so.size + part.byteLength > DOCUMENT_BYTES
            ? Effect.fail("large" as const)
            : Effect.succeed({ size: so.size + part.byteLength, parts: [...so.parts, part] }),
      ),
    );
    return new TextDecoder().decode(
      read.parts.reduce((all, part, index) => {
        all.set(
          part,
          read.parts.slice(0, index).reduce((at, one) => at + one.byteLength, 0),
        );
        return all;
      }, new Uint8Array(read.size)),
    );
  });

  /** What a provider says of how it is reached, where it says what signing in takes. */
  const discovered = Effect.fn("Providers.discovered")(
    function* (issuer: string) {
      const given = issuer.trim();
      const unusable = refused("The issuer", given);
      if (Option.isSome(unusable)) {
        return yield* new DiscoveryFailed({ problems: [unusable.value] });
      }
      const url = discoveryOf(given);
      const failed = (problem: string) => new DiscoveryFailed({ problems: [problem] });
      // Redirects are not followed: the address that was checked is the one that is asked.
      const answer = yield* client
        .execute(HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson))
        .pipe(Effect.mapError(() => failed(`Nothing answers at ${url}.`)));
      if (REDIRECTS.includes(answer.status)) {
        return yield* failed(`${url} redirects elsewhere. Give the address it ends at.`);
      }
      if (answer.status !== OK) {
        return yield* failed(`${url} answered ${answer.status}.`);
      }
      const text = yield* whole(answer).pipe(
        Effect.mapError((why) =>
          failed(
            why === "large"
              ? `What ${url} answers is too large to be a discovery document.`
              : `${url} stopped answering midway.`,
          ),
        ),
      );
      const document = yield* Schema.decodeUnknownEffect(Document)(text).pipe(
        Effect.mapError(() => failed(`What ${url} answers is not a discovery document.`)),
      );

      const problems: Array<string> = [];
      const expected = slashless(url.slice(0, -WELL_KNOWN.length));
      if (document.issuer === undefined) {
        problems.push("The document does not say who its issuer is.");
      } else if (slashless(document.issuer) !== expected) {
        problems.push(`The document is of the issuer ${document.issuer}, and not of ${expected}.`);
      }
      for (const [field, what] of ENDPOINTS) {
        const endpoint = document[field];
        if (endpoint === undefined) {
          problems.push(`The document does not name ${what} (${field}).`);
          continue;
        }
        const wrong = refused(`${field}, ${what},`, endpoint);
        if (Option.isSome(wrong)) {
          problems.push(wrong.value);
        }
      }
      if (problems.length > 0) {
        return yield* new DiscoveryFailed({ problems });
      }
      return document;
    },
    Effect.timeoutOrElse({
      duration: ANSWERS_WITHIN,
      orElse: () =>
        Effect.fail(
          new DiscoveryFailed({
            problems: [`The provider did not answer within ${ANSWERS_WITHIN}.`],
          }),
        ),
    }),
  );

  /** Why any of the places a provider is asked at is none this program asks. */
  const misplaced = (endpoints: Endpoints) =>
    PLACES.flatMap(([place, what]) => {
      const url = endpoints[place];
      return url === null ? [] : Option.toArray(refused(what, url));
    });

  /**
   * What is wrong with where a provider that speaks OAuth 2.0 alone is asked. It says
   * nowhere how it is reached, so each place is asked as nobody: where people are sent is
   * there, where a token is given answers at all, which GitHub's does a client it does not
   * know with 404, and where a token tells of someone asks who asks.
   */
  const answering = Effect.fn("Providers.answering")(function* (endpoints: Endpoints) {
    const unusable = misplaced(endpoints);
    if (unusable.length > 0) {
      return unusable;
    }
    const problems = yield* Effect.forEach(
      PLACES,
      Effect.fn(function* ([place]) {
        const url = endpoints[place];
        if (url === null) {
          return Arr.empty<string>();
        }
        const request =
          place === "token"
            ? HttpClientRequest.post(url).pipe(
                HttpClientRequest.bodyUrlParams({ grant_type: "authorization_code" }),
              )
            : HttpClientRequest.get(url);
        const answer = yield* client
          .execute(
            request.pipe(
              HttpClientRequest.acceptJson,
              HttpClientRequest.setHeader("user-agent", AGENT),
            ),
          )
          .pipe(Effect.option, Effect.timeoutOption(ANSWERS_WITHIN));
        if (Option.isNone(answer)) {
          return [`${url} did not answer within ${ANSWERS_WITHIN}.`];
        }
        if (Option.isNone(answer.value)) {
          return [`Nothing answers at ${url}.`];
        }
        const { status } = answer.value.value;
        // What it answers with is not read, and not left unread either.
        yield* Effect.ignore(whole(answer.value.value));
        if (status >= FAILED_FROM || (place === "authorization" && status === NOT_FOUND)) {
          return [`${url} answered ${status}.`];
        }
        if ((place === "userInfo" || place === "emails") && !ASKS_WHO.includes(status)) {
          return [`${url} answered ${status} to nobody, where it has to ask who asks.`];
        }
        return Arr.empty<string>();
      }),
      { concurrency: "unbounded" },
    );
    return problems.flat();
  });

  const check = Effect.fn("Providers.check")(function* (asked: Asked) {
    if ("endpoints" in asked) {
      const problems = yield* answering(endpointsOf(asked.endpoints));
      return { ok: problems.length === 0, problems, scopes: Arr.empty<string>() };
    }
    return yield* discovered(asked.issuer).pipe(
      Effect.map((document) => ({
        ok: true,
        problems: Arr.empty<string>(),
        scopes: Arr.dedupe(document.scopes_supported ?? []),
      })),
      Effect.catchTag("DiscoveryFailed", ({ problems }) =>
        Effect.succeed({ ok: false, problems, scopes: Arr.empty<string>() }),
      ),
    );
  });

  const toldStored = (provider: StoredProvider): ToldProvider => ({
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    issuer: provider.issuer,
    endpoints: provider.endpoints,
    clientId: provider.clientId,
    secretSet: provider.clientSecretSealed !== "",
    scopes: provider.scopes,
    provision: provider.provision,
    domains: provider.domains,
    enabled: provider.enabled,
    source: "stored",
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  });

  // What the settings say of all their providers together is what each of them is told to
  // do by itself.
  const toldConfigured = (provider: Provider): ToldProvider => ({
    id: provider.id,
    name: provider.name,
    kind: "oidc",
    issuer: provider.discoveryUrl.endsWith(WELL_KNOWN)
      ? provider.discoveryUrl.slice(0, -WELL_KNOWN.length)
      : provider.discoveryUrl,
    endpoints: null,
    clientId: provider.clientId,
    secretSet: true,
    scopes: SCOPES,
    provision: settings.provisionPeople,
    domains: settings.provisionDomains,
    enabled: true,
    source: "configuration",
    createdAt: null,
    updatedAt: null,
  });

  const configured = (id: string) => settings.providers.some((provider) => provider.id === id);

  const list = Effect.fn("Providers.list")(function* () {
    const stored = yield* store.list();
    return [...settings.providers.map(toldConfigured), ...stored.map(toldStored)];
  });

  /** What is said of a provider as it is kept, or why it is not kept as that. */
  const said = Effect.fn("Providers.said")(function* (given: {
    readonly name: string;
    readonly kind: Kind;
    readonly issuer: string;
    readonly endpoints: Endpoints | null;
    readonly clientId: string;
    readonly scopes: ReadonlyArray<string>;
    readonly domains: ReadonlyArray<string>;
    readonly enabled: boolean;
  }) {
    const issuer = given.issuer.trim();
    const name = given.name.trim();
    const clientId = given.clientId.trim();
    const invalid = (message: string, problems: ReadonlyArray<string> = [message]) =>
      new ProviderInvalid({ message, problems });
    if (name === "" || clientId === "") {
      return yield* invalid("A provider has a name and a client id.");
    }
    const unreached = (problems: ReadonlyArray<string>) =>
      invalid(
        "The provider is not reached as one has to be. Save it disabled to keep it anyway.",
        problems,
      );
    const domains = Arr.dedupe(given.domains.map((domain) => domain.toLowerCase()));
    if (given.kind === "oauth2") {
      const { endpoints } = given;
      if (endpoints === null) {
        return yield* invalid("A provider that speaks OAuth 2.0 alone is told where it is asked.");
      }
      const [first, ...others] = misplaced(endpoints);
      if (first !== undefined) {
        return yield* invalid(first, [first, ...others]);
      }
      if (given.enabled) {
        const problems = yield* answering(endpoints);
        if (problems.length > 0) {
          return yield* unreached(problems);
        }
      }
      // Nothing is asked of it that was not said: there is no scope all of them know.
      return { name, issuer: "", endpoints, clientId, scopes: Arr.dedupe(given.scopes), domains };
    }
    if (issuer === "") {
      return yield* invalid("A provider that speaks OpenID Connect has an issuer.");
    }
    const unusable = refused("The issuer", issuer);
    if (Option.isSome(unusable)) {
      return yield* invalid(unusable.value);
    }
    if (given.enabled) {
      yield* discovered(issuer).pipe(Effect.mapError(({ problems }) => unreached(problems)));
    }
    return {
      name,
      issuer,
      endpoints: null,
      clientId,
      scopes: given.scopes.length === 0 ? SCOPES : Arr.dedupe(given.scopes),
      domains,
    };
  });

  const resource = (provider: { readonly id: string; readonly name: string }) => ({
    kind: "provider" as const,
    id: provider.id,
    label: provider.name,
  });

  const create = Effect.fn("Providers.create")(function* (given: GivenProvider) {
    if (configured(given.id)) {
      return yield* new ProviderTaken({
        id: given.id,
        message: "The settings name a provider by that id.",
      });
    }
    const enabled = given.enabled ?? true;
    const kind = given.kind ?? "oidc";
    const kept = yield* said({
      name: given.name,
      kind,
      issuer: given.issuer ?? "",
      endpoints: given.endpoints === undefined ? null : endpointsOf(given.endpoints),
      clientId: given.clientId,
      scopes: given.scopes ?? [],
      domains: given.domains ?? [],
      enabled,
    });
    const made = yield* store.insert({
      ...kept,
      id: given.id,
      kind,
      clientSecretSealed: yield* vault.seal(given.clientSecret, sealedAs(given.id)),
      provision: given.provision ?? false,
      enabled,
      createdAt: yield* now,
    });
    if (Option.isNone(made)) {
      return yield* new ProviderTaken({
        id: given.id,
        message: "A provider is known by that id already.",
      });
    }
    yield* events.record({
      kind: "provider.added",
      resource: resource(made.value),
      detail: {
        kind: made.value.kind,
        issuer: made.value.issuer,
        enabled: made.value.enabled,
        provision: made.value.provision,
      },
    });
    return toldStored(made.value);
  });

  /** The provider an admin may change by that id, or why there is none. */
  const changeable = Effect.fn("Providers.changeable")(function* (id: string) {
    if (configured(id)) {
      return yield* new ProviderConfigured({
        id,
        message: "The settings name this provider: it is changed and removed there.",
      });
    }
    const found = yield* store.find(id);
    if (Option.isNone(found)) {
      return yield* new ProviderNotFound({ id });
    }
    return found.value;
  });

  const change = Effect.fn("Providers.change")(function* (id: string, changed: ChangedProvider) {
    const was = yield* changeable(id);
    const enabled = changed.enabled ?? was.enabled;
    const provision = changed.provision ?? was.provision;
    const kept = yield* said({
      name: changed.name ?? was.name,
      kind: was.kind,
      issuer: changed.issuer ?? was.issuer,
      endpoints: changed.endpoints === undefined ? was.endpoints : endpointsOf(changed.endpoints),
      clientId: changed.clientId ?? was.clientId,
      scopes: changed.scopes ?? was.scopes,
      domains: changed.domains ?? was.domains,
      enabled,
    });
    const secret =
      changed.clientSecret === undefined || changed.clientSecret === ""
        ? Option.none<string>()
        : Option.some(changed.clientSecret);
    const updated = yield* store.update(id, {
      ...kept,
      clientSecretSealed: Option.isNone(secret)
        ? was.clientSecretSealed
        : yield* vault.seal(secret.value, sealedAs(id)),
      provision,
      enabled,
      updatedAt: yield* now,
    });
    if (Option.isNone(updated)) {
      return yield* new ProviderNotFound({ id });
    }
    const is = updated.value;
    // What was changed is told by its name, and a secret by nothing else.
    const fields = [
      ...(is.name === was.name ? [] : ["name"]),
      ...(is.issuer === was.issuer ? [] : ["issuer"]),
      ...(JSON.stringify(is.endpoints) === JSON.stringify(was.endpoints) ? [] : ["endpoints"]),
      ...(is.clientId === was.clientId ? [] : ["clientId"]),
      ...(Option.isNone(secret) ? [] : ["clientSecret"]),
      ...(Arr.join(is.scopes, " ") === Arr.join(was.scopes, " ") ? [] : ["scopes"]),
      ...(is.provision === was.provision ? [] : ["provision"]),
      ...(Arr.join(is.domains, " ") === Arr.join(was.domains, " ") ? [] : ["domains"]),
    ];
    if (fields.length > 0) {
      yield* events.record({
        kind: "provider.changed",
        resource: resource(is),
        detail: { changed: fields },
      });
    }
    if (is.enabled !== was.enabled) {
      yield* events.record({
        kind: is.enabled ? "provider.enabled" : "provider.disabled",
        resource: resource(is),
      });
    }
    return toldStored(is);
  });

  const remove = Effect.fn("Providers.remove")(function* (id: string) {
    const was = yield* changeable(id);
    yield* store.delete(id);
    yield* events.record({ kind: "provider.removed", resource: resource(was) });
  });

  const active = Effect.fn("Providers.active")(function* () {
    const stored = yield* store.list();
    const added = yield* Effect.forEach(
      stored.filter((provider) => provider.enabled),
      Effect.fn(function* (provider) {
        if (configured(provider.id)) {
          yield* Effect.logWarning(
            `the provider ${provider.id} an admin added is not used: the settings name one by that id`,
          );
          return Option.none<ActiveProvider>();
        }
        const secret = yield* vault.open(provider.clientSecretSealed, sealedAs(provider.id)).pipe(
          Effect.map(Option.some),
          Effect.catchTag("Unsealable", (error) =>
            Effect.as(
              Effect.logWarning(`the provider ${provider.id} is not used: ${error.message}`),
              Option.none<string>(),
            ),
          ),
        );
        if (provider.kind === "oauth2" && provider.endpoints === null) {
          yield* Effect.logWarning(
            `the provider ${provider.id} is not used: it is kept without where it is asked`,
          );
          return Option.none<ActiveProvider>();
        }
        return Option.map(
          secret,
          (opened): ActiveProvider => ({
            id: provider.id,
            name: provider.name,
            ...(provider.kind === "oauth2" && provider.endpoints !== null
              ? { kind: "oauth2", endpoints: provider.endpoints }
              : { kind: "oidc", discoveryUrl: discoveryOf(provider.issuer) }),
            clientId: provider.clientId,
            clientSecret: Redacted.make(opened),
            scopes: provider.scopes,
            provision: provider.provision,
            domains: provider.domains,
            stored: true,
          }),
        );
      }),
    );
    return [
      ...settings.providers.map(
        (provider): ActiveProvider => ({
          ...provider,
          kind: "oidc",
          scopes: SCOPES,
          provision: settings.provisionPeople,
          domains: settings.provisionDomains,
          stored: false,
        }),
      ),
      ...Arr.getSomes(added),
    ];
  });

  const revision = Effect.fn("Providers.revision")(function* () {
    return yield* store.revision();
  });

  /** What a place that tells of a token's holder answers with it, where it answers. */
  const toldWith = Effect.fn("Providers.toldWith")(function* (url: string, accessToken: string) {
    const answer = yield* client.execute(
      HttpClientRequest.get(url).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(accessToken),
        HttpClientRequest.setHeader("user-agent", AGENT),
      ),
    );
    if (answer.status !== OK) {
      // What it answers with is not read, and not left unread either.
      yield* Effect.ignore(whole(answer));
      return yield* Effect.fail(`${url} answered ${answer.status}` as const);
    }
    return yield* whole(answer);
  });

  const vouched = Effect.fn("Providers.vouched")(
    function* (endpoints: Endpoints, accessToken: string) {
      const info = yield* toldWith(endpoints.userInfo, accessToken).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(UserInfo)),
      );
      const id = info.id ?? info.sub;
      if (id === undefined || id === null || String(id) === "") {
        return Option.none<Vouched>();
      }
      // The address that is theirs first, where the provider lists them apart: another of
      // theirs is none they are known by here, verified or not.
      const address =
        endpoints.emails === null
          ? { email: info.email ?? "", verified: info.email_verified === true }
          : yield* toldWith(endpoints.emails, accessToken).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Emails)),
              Effect.map((all) => {
                const first = all.find((one) => one.primary === true);
                return { email: first?.email ?? "", verified: first?.verified === true };
              }),
            );
      if (address.email === "") {
        return Option.none<Vouched>();
      }
      return Option.some<Vouched>({
        id: String(id),
        email: address.email,
        emailVerified: address.verified,
        name: info.name ?? info.login ?? address.email,
      });
    },
    Effect.timeoutOption(ANSWERS_WITHIN),
    Effect.map(Option.flatten),
    // Why not is no secret, and the token that was asked with is not in it.
    Effect.catch((error) =>
      Effect.as(
        Effect.logWarning(
          `a provider did not tell who signs in: ${typeof error === "string" ? error : "what it answered is not read"}`,
        ),
        Option.none<Vouched>(),
      ),
    ),
  );

  return Providers.of({ list, create, change, remove, check, vouched, active, revision });
});

export const layer = Layer.effect(Providers, makeProviders());
