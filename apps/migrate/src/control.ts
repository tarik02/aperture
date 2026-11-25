import * as Accounts from "@aperture-browser/control/src/accounts/layer.ts";
import * as AccountsStoreSql from "@aperture-browser/control/src/accounts/store-sql.ts";
import * as Database from "@aperture-browser/control/src/database.ts";
import * as Events from "@aperture-browser/control/src/events/layer.ts";
import * as EventsStoreSql from "@aperture-browser/control/src/events/store-sql.ts";
import * as GrantsStoreSql from "@aperture-browser/control/src/grants/store-sql.ts";
import * as Identity from "@aperture-browser/control/src/identity/layer.ts";
import * as Nodes from "@aperture-browser/control/src/nodes/layer.ts";
import * as NodesStoreSql from "@aperture-browser/control/src/nodes/store-sql.ts";
import * as Providers from "@aperture-browser/control/src/providers/layer.ts";
import * as ProvidersStoreSql from "@aperture-browser/control/src/providers/store-sql.ts";
import * as SessionsStoreSql from "@aperture-browser/control/src/sessions/store-sql.ts";
import * as Settings from "@aperture-browser/control/src/settings/layer.ts";
import * as SharesStoreSql from "@aperture-browser/control/src/shares/store-sql.ts";
import * as SnapshotsStoreSql from "@aperture-browser/control/src/snapshots/store-sql.ts";
import * as V1Credentials from "@aperture-browser/control/src/v1-credentials/layer.ts";
import * as Vault from "@aperture-browser/control/src/vault/layer.ts";
import * as WorkspacesStoreSql from "@aperture-browser/control/src/workspaces/store-sql.ts";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Layer from "effect/Layer";

const stores = Layer.mergeAll(
  AccountsStoreSql.layer,
  EventsStoreSql.layer,
  GrantsStoreSql.layer,
  NodesStoreSql.layer,
  ProvidersStoreSql.layer,
  SessionsStoreSql.layer,
  SharesStoreSql.layer,
  SnapshotsStoreSql.layer,
  WorkspacesStoreSql.layer,
  V1Credentials.layer.pipe(Layer.provide(AccountsStoreSql.layer)),
).pipe(Layer.provideMerge(Database.layer));

/**
 * The control plane's own stores and services on its database, as its settings name it:
 * what is moved is written by what the control plane writes with, so that a person, a
 * token and an event are made here as they are made there. The database itself is given
 * as well, for what is kept together with what they write, and the vault, which seals a
 * session's routing as the control plane does.
 */
export const layer = Accounts.layer.pipe(
  Layer.provideMerge(Nodes.layer),
  Layer.provideMerge(Identity.layer),
  Layer.provideMerge(Providers.layer),
  Layer.provideMerge(Events.layer),
  Layer.provideMerge(stores),
  Layer.provide(NodeHttpClient.layerUndici),
  Layer.provideMerge(Vault.layer),
  Layer.provide(Settings.layer),
);
