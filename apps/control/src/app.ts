import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as Accounts from "./accounts/layer.ts";
import * as AccountsStoreMemory from "./accounts/store-memory.ts";
import * as AccountsStoreSql from "./accounts/store-sql.ts";
import { Api, PREFIX } from "./api.ts";
import * as Database from "./database.ts";
import * as Following from "./following.ts";
import * as Authorization from "./http/authorization.ts";
import * as Handlers from "./http/handlers.ts";
import * as NodeServiceRoutes from "./http/nodeService.ts";
import * as Nodes from "./nodes/layer.ts";
import * as NodesStoreMemory from "./nodes/store-memory.ts";
import * as NodesStoreSql from "./nodes/store-sql.ts";
import * as Sessions from "./sessions/layer.ts";
import * as SessionsStoreMemory from "./sessions/store-memory.ts";
import * as SessionsStoreSql from "./sessions/store-sql.ts";
import * as Snapshots from "./snapshots/layer.ts";
import * as SnapshotsStoreMemory from "./snapshots/store-memory.ts";
import * as SnapshotsStoreSql from "./snapshots/store-sql.ts";
import * as Memory from "./store/memory.ts";
import * as Tickets from "./tickets/layer.ts";
import * as Vault from "./vault/layer.ts";

/** The stores on the database the settings name, migrated before anything is asked of it. */
export const stores = Layer.mergeAll(
  AccountsStoreSql.layer,
  NodesStoreSql.layer,
  SessionsStoreSql.layer,
  SnapshotsStoreSql.layer,
).pipe(Layer.provide(Database.layer));

/** The stores on nothing but memory, which is gone with the layer. */
export const storesTest = Layer.mergeAll(
  AccountsStoreMemory.layerTest,
  NodesStoreMemory.layerTest,
  SessionsStoreMemory.layerTest,
  SnapshotsStoreMemory.layerTest,
).pipe(Layer.provide(Memory.layer));

/** What the control plane knows and does, whoever asks: over HTTP, or by itself. */
export const services = Snapshots.layer.pipe(
  Layer.provideMerge(Sessions.layer),
  Layer.provideMerge(Layer.mergeAll(Accounts.layer, Nodes.layer, Tickets.layer)),
  Layer.provide(Vault.layer),
);

const api = HttpApiBuilder.layer(Api, { openapiPath: `${PREFIX}/openapi.json` }).pipe(
  Layer.provide(Handlers.layer),
  Layer.provide(Authorization.layer),
);

const serving = Layer.mergeAll(
  HttpRouter.serve(Layer.mergeAll(api, NodeServiceRoutes.layer)),
  Following.layer,
).pipe(Layer.provide(services));

/**
 * The control plane on whatever HTTP server it is given: its API, the service nodes call,
 * and the following of nodes, for as long as the layer lasts.
 */
export const layer = serving.pipe(Layer.provide(stores));

/** The same with nothing kept beyond the layer: for checks that need no database. */
export const layerTest = serving.pipe(Layer.provide(storesTest));
