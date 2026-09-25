import * as Layer from "effect/Layer";
import { authApiLayer } from "./auth/layer.ts";
import { apiAuthorizationLayer, authorizedHttpClientLayer } from "./authorization/layer.ts";
import { eventsApiLayer } from "./events/layer.ts";
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
).pipe(Layer.provide(authorizedHttpClientLayer), Layer.provideMerge(apiAuthorizationLayer));

export type ApiServices = Layer.Success<typeof apiClientLayer>;
