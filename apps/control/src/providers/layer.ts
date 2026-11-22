import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
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
import { discoveryOf, SCOPES, type StoredProvider, WELL_KNOWN } from "./schemas.ts";
import {
  type ActiveProvider,
  type ChangedProvider,
  type GivenProvider,
  Providers,
  type ToldProvider,
} from "./service.ts";
import { ProvidersStore } from "./store.ts";

/** A provider that takes longer to say how it is reached keeps people waiting as long. */
const ANSWERS_WITHIN = "5 seconds";
/** Many times what any provider says of itself, and little to hold in memory. */
const DOCUMENT_BYTES = 256 * 1024;
const OK = 200;
const REDIRECTS = [301, 302, 303, 307, 308];
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

const slashless = (address: string) => address.replace(/\/+$/u, "");

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
      const read = yield* answer.stream.pipe(
        Stream.mapError(() => failed(`${url} stopped answering midway.`)),
        Stream.runFoldEffect(
          () => ({ size: 0, parts: Arr.empty<Uint8Array>() }),
          (so, part) =>
            so.size + part.byteLength > DOCUMENT_BYTES
              ? Effect.fail(failed(`What ${url} answers is too large to be a discovery document.`))
              : Effect.succeed({ size: so.size + part.byteLength, parts: [...so.parts, part] }),
        ),
      );
      const text = new TextDecoder().decode(
        read.parts.reduce((whole, part, index) => {
          whole.set(
            part,
            read.parts.slice(0, index).reduce((at, one) => at + one.byteLength, 0),
          );
          return whole;
        }, new Uint8Array(read.size)),
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

  const check = Effect.fn("Providers.check")(function* (issuer: string) {
    return yield* discovered(issuer).pipe(
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
    issuer: provider.issuer,
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
    issuer: provider.discoveryUrl.endsWith(WELL_KNOWN)
      ? provider.discoveryUrl.slice(0, -WELL_KNOWN.length)
      : provider.discoveryUrl,
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
    readonly issuer: string;
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
    const unusable = refused("The issuer", issuer);
    if (Option.isSome(unusable)) {
      return yield* invalid(unusable.value);
    }
    if (given.enabled) {
      yield* discovered(issuer).pipe(
        Effect.mapError(({ problems }) =>
          invalid(
            "The provider is not reached as one has to be. Save it disabled to keep it anyway.",
            problems,
          ),
        ),
      );
    }
    return {
      name,
      issuer,
      clientId,
      scopes: given.scopes.length === 0 ? SCOPES : Arr.dedupe(given.scopes),
      domains: Arr.dedupe(given.domains.map((domain) => domain.toLowerCase())),
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
    const kept = yield* said({
      name: given.name,
      issuer: given.issuer,
      clientId: given.clientId,
      scopes: given.scopes ?? SCOPES,
      domains: given.domains ?? [],
      enabled,
    });
    const made = yield* store.insert({
      ...kept,
      id: given.id,
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
      issuer: changed.issuer ?? was.issuer,
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
        return Option.map(
          secret,
          (opened): ActiveProvider => ({
            id: provider.id,
            name: provider.name,
            discoveryUrl: discoveryOf(provider.issuer),
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

  return Providers.of({ list, create, change, remove, check, active, revision });
});

export const layer = Layer.effect(Providers, makeProviders());
