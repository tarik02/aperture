import { Api, PREFIX } from "@aperture-browser/control-api";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpStaticServer from "effect/http/HttpStaticServer";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Accounts from "./accounts/layer.ts";
import * as AccountsStoreMemory from "./accounts/store-memory.ts";
import * as AccountsStoreSql from "./accounts/store-sql.ts";
import * as Database from "./database.ts";
import * as Following from "./following.ts";
import * as Forgetting from "./grants/forgetting.ts";
import * as Grants from "./grants/layer.ts";
import * as GrantsStoreMemory from "./grants/store-memory.ts";
import * as GrantsStoreSql from "./grants/store-sql.ts";
import * as Authorization from "./http/authorization.ts";
import * as Handlers from "./http/handlers.ts";
import * as IdentityRoutes from "./http/identity.ts";
import * as McpRoutes from "./http/mcp.ts";
import * as OAuthRoutes from "./http/oauth.ts";
import * as NodeServiceRoutes from "./http/nodeService.ts";
import * as Identity from "./identity/layer.ts";
import * as SessionTools from "./mcp/layer.ts";
import * as RoutingRoutes from "./http/routing.ts";
import * as Nodes from "./nodes/layer.ts";
import * as NodesStoreMemory from "./nodes/store-memory.ts";
import * as NodesStoreSql from "./nodes/store-sql.ts";
import * as Routing from "./routing/layer.ts";
import * as Sessions from "./sessions/layer.ts";
import { Settings } from "./settings/service.ts";
import * as SessionsStoreMemory from "./sessions/store-memory.ts";
import * as SessionsStoreSql from "./sessions/store-sql.ts";
import * as Snapshots from "./snapshots/layer.ts";
import * as SnapshotsStoreMemory from "./snapshots/store-memory.ts";
import * as SnapshotsStoreSql from "./snapshots/store-sql.ts";
import * as Memory from "./store/memory.ts";
import * as Tickets from "./tickets/layer.ts";
import * as Vault from "./vault/layer.ts";
import * as Workspaces from "./workspaces/layer.ts";
import * as WorkspacesStoreMemory from "./workspaces/store-memory.ts";
import * as WorkspacesStoreSql from "./workspaces/store-sql.ts";

/** The stores on the database the settings name, migrated before anything is asked of it. */
export const stores = Layer.mergeAll(
  AccountsStoreSql.layer,
  GrantsStoreSql.layer,
  NodesStoreSql.layer,
  SessionsStoreSql.layer,
  SnapshotsStoreSql.layer,
  WorkspacesStoreSql.layer,
).pipe(Layer.provide(Database.layer));

/** The stores on nothing but memory, which is gone with the layer. */
export const storesTest = Layer.mergeAll(
  AccountsStoreMemory.layerTest,
  GrantsStoreMemory.layerTest,
  NodesStoreMemory.layerTest,
  SessionsStoreMemory.layerTest,
  SnapshotsStoreMemory.layerTest,
  WorkspacesStoreMemory.layerTest,
).pipe(Layer.provide(Memory.layer));

/** What the control plane knows and does, whoever asks: over HTTP, or by itself. */
export const services = Layer.mergeAll(
  Snapshots.layer,
  Routing.layer,
  Workspaces.layer,
  SessionTools.layer.pipe(Layer.provide(NodeHttpClient.layerUndici)),
).pipe(
  Layer.provideMerge(Sessions.layer),
  Layer.provideMerge(Layer.mergeAll(Accounts.layer, Grants.layer, Nodes.layer, Tickets.layer)),
);

const api = HttpApiBuilder.layer(Api, { openapiPath: `${PREFIX}/openapi.json` }).pipe(
  Layer.provide(Handlers.layer),
  Layer.provide(Authorization.layer),
);

/** The console, where the settings name one: every path that is nothing else's is its page. */
const consolePages = Layer.unwrap(
  Effect.gen(function* () {
    const settings = yield* Settings;
    return Option.match(settings.consoleDir, {
      onNone: () => Layer.empty,
      onSome: (root) => HttpStaticServer.layer({ root, spa: true }),
    });
  }),
);

const serving = Layer.mergeAll(
  HttpRouter.serve(
    Layer.mergeAll(
      api,
      NodeServiceRoutes.layer,
      RoutingRoutes.layer,
      IdentityRoutes.layer,
      McpRoutes.layer,
      OAuthRoutes.layer,
      consolePages,
    ),
  ),
  Following.layer,
  Forgetting.layer,
).pipe(Layer.provide(services));

/**
 * The control plane on whatever HTTP server it is given: its API, the service nodes call,
 * the following of nodes and the forgetting of what apps left, for as long as the layer
 * lasts.
 */
export const layer = serving.pipe(
  Layer.provide(Layer.mergeAll(stores, Identity.layer)),
  Layer.provide(Vault.layer),
);

/** The same with nothing kept beyond the layer: for checks that need no database. */
export const layerTest = serving.pipe(
  Layer.provide(Layer.mergeAll(storesTest, Identity.layerTest)),
  Layer.provide(Vault.layer),
);
