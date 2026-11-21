import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import { Accounts } from "./accounts.ts";
import { Api, PREFIX } from "./api.ts";
import * as Database from "./database.ts";
import * as Following from "./following.ts";
import * as Authorization from "./http/authorization.ts";
import * as Handlers from "./http/handlers.ts";
import * as NodeServiceRoutes from "./http/nodeService.ts";
import { Nodes } from "./nodes.ts";
import { Sessions } from "./sessions.ts";
import { AccountsStore } from "./store/accounts.ts";
import { NodesStore } from "./store/nodes.ts";
import { SessionsStore } from "./store/sessions.ts";
import { Tickets } from "./tickets.ts";

const stores = Layer.mergeAll(AccountsStore.layer, NodesStore.layer, SessionsStore.layer).pipe(
  Layer.provide(Database.layer),
);

/** What the control plane knows and does, whoever asks: over HTTP, or by itself. */
export const services = Sessions.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(Accounts.layer, Nodes.layer, Tickets.layer)),
  Layer.provide(stores),
);

const api = HttpApiBuilder.layer(Api, { openapiPath: `${PREFIX}/openapi.json` }).pipe(
  Layer.provide(Handlers.layer),
  Layer.provide(Authorization.layer),
);

/**
 * The control plane on whatever HTTP server it is given: its API, the service nodes call,
 * and the following of nodes, for as long as the layer lasts.
 */
export const layer = Layer.mergeAll(
  HttpRouter.serve(Layer.mergeAll(api, NodeServiceRoutes.layer)),
  Following.layer,
).pipe(Layer.provide(services));
