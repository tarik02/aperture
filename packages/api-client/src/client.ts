import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ApiCredentials } from "./authorization/service.ts";
import { EventsApi } from "./events/service.ts";
import { apiClientLayer } from "./layer.ts";
import { SessionsApi } from "./sessions/service.ts";
import { SnapshotsApi } from "./snapshots/service.ts";
import { TenantsApi } from "./tenants/service.ts";
import { TokensApi } from "./tokens/service.ts";
import { UsersApi } from "./users/service.ts";

type CredentialedMethod = (credentials: ApiCredentials, ...args: never[]) => unknown;

/** A service whose methods have their leading credentials argument already applied. */
export type WithCredentials<S> = {
  readonly [K in keyof S]: S[K] extends (
    credentials: ApiCredentials,
    ...args: infer Args
  ) => infer Result
    ? (...args: Args) => Result
    : never;
};

/** Binds `credentials` as the first argument of every method of `service`. */
export function withCredentials<S extends { readonly [K in keyof S]: CredentialedMethod }>(
  service: S,
  credentials: ApiCredentials,
): WithCredentials<S> {
  const methods: ReadonlyArray<[string, CredentialedMethod]> = Object.entries(service);
  const bound = Object.fromEntries(
    methods.map(([name, method]) => [name, (...args: never[]) => method(credentials, ...args)]),
  );
  // Object.fromEntries forgets the per-method signatures that WithCredentials restores.
  return bound as WithCredentials<S>;
}

/**
 * The credentialed API services with one set of credentials bound, for callers that always
 * act as the same principal, such as a server holding one API token.
 */
export class ApertureClient extends Context.Service<
  ApertureClient,
  {
    readonly sessions: WithCredentials<SessionsApi["Service"]>;
    readonly snapshots: WithCredentials<SnapshotsApi["Service"]>;
    readonly tenants: WithCredentials<TenantsApi["Service"]>;
    readonly users: WithCredentials<UsersApi["Service"]>;
    readonly tokens: WithCredentials<TokensApi["Service"]>;
    readonly events: WithCredentials<EventsApi["Service"]>;
  }
>()("@aperture-browser/api-client/ApertureClient") {}

export const makeApertureClient = Effect.fn("makeApertureClient")(function* (
  credentials: ApiCredentials,
) {
  return ApertureClient.of({
    sessions: withCredentials(yield* SessionsApi, credentials),
    snapshots: withCredentials(yield* SnapshotsApi, credentials),
    tenants: withCredentials(yield* TenantsApi, credentials),
    users: withCredentials(yield* UsersApi, credentials),
    tokens: withCredentials(yield* TokensApi, credentials),
    events: withCredentials(yield* EventsApi, credentials),
  });
});

/** ApertureClient acting with `credentials`, over the HttpClient the app provides. */
export const apertureClientLayer = (credentials: ApiCredentials) =>
  Layer.effect(ApertureClient, makeApertureClient(credentials)).pipe(Layer.provide(apiClientLayer));
