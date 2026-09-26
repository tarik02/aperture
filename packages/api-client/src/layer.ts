import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { authApiLayer } from "./auth/layer.ts";
import { apiAuthorizationLayer, authorizedHttpClientLayer } from "./authorization/layer.ts";
import { eventsApiLayer } from "./events/layer.ts";
import { healthApiLayer } from "./health/layer.ts";
import { sessionsApiLayer } from "./sessions/layer.ts";
import { snapshotsApiLayer } from "./snapshots/layer.ts";
import { tenantsApiLayer } from "./tenants/layer.ts";
import { tokensApiLayer } from "./tokens/layer.ts";
import { usersApiLayer } from "./users/layer.ts";

/**
 * Every API service, sharing one ApiAuthorization. The services send requests through the
 * HttpClient the app provides, decorated with each call's authorization.
 */
export const apiClientLayer = Layer.mergeAll(
  authApiLayer,
  tenantsApiLayer,
  usersApiLayer,
  sessionsApiLayer,
  snapshotsApiLayer,
  tokensApiLayer,
  eventsApiLayer,
  healthApiLayer,
).pipe(Layer.provide(authorizedHttpClientLayer), Layer.provideMerge(apiAuthorizationLayer));

export type ApiServices = Layer.Success<typeof apiClientLayer>;

export const baseUrlLayer = (baseUrl: string) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, HttpClient.mapRequest(HttpClientRequest.prependUrl(baseUrl))),
  );
