import {
  AuthApi,
  SessionsApi,
  SnapshotsApi,
  type ApiCredentials,
  type InitialBrowserStorageState,
  type InitialBrowserTarget,
} from "@aperture-browser/api-client";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { credentials, withApi } from "./api.ts";
import { CompanionError, openTab, requestOrigins } from "./chrome.ts";
import { NonEmptyString, type Tags } from "./schema.ts";
import { storedValue } from "./storage.ts";

/** An Aperture instance and the API token the extension uses there. */
export const Connection = Schema.Struct({
  id: NonEmptyString,
  origin: NonEmptyString,
  token: NonEmptyString,
  authorityType: Schema.Literals(["system_admin", "tenant"]),
  tenantId: Schema.NullOr(Schema.String),
  selectedTenantId: Schema.NullOr(Schema.String),
  tenantName: Schema.String,
  channel: NonEmptyString,
  channels: Schema.Array(NonEmptyString).check(Schema.isMinLength(1)),
  scopes: Schema.Array(Schema.String),
});
export type Connection = typeof Connection.Type;

export const ConnectionDraft = Schema.Struct({ origin: Schema.String, token: Schema.String });
export type ConnectionDraft = typeof ConnectionDraft.Type;

const ConnectionStore = Schema.Struct({
  connections: Schema.Array(Connection),
  activeConnectionId: Schema.NullOr(Schema.String),
});
type ConnectionStore = typeof ConnectionStore.Type;

// Tokens stay in local storage, which Chromium never synchronizes.
const connectionStore = storedValue("local", "apertureConnections", ConnectionStore);

/** The add-connection form, kept while the popup closes for the permission prompt. */
export const connectionDraft = storedValue("session", "apertureConnectionDraft", ConnectionDraft);

export const emptyConnectionDraft: ConnectionDraft = { origin: "", token: "" };

const loadStore = connectionStore.get.pipe(
  Effect.map(Option.getOrElse(() => ({ connections: [], activeConnectionId: null }))),
);

const unavailable = new CompanionError({ message: "The Aperture connection is unavailable" });

export const normalizeConnectionOrigin = Effect.fnUntraced(function* (input: string) {
  const url = yield* Effect.try({
    try: () => new URL(input.trim()),
    catch: () => new CompanionError({ message: "Aperture URL is invalid" }),
  });
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return yield* new CompanionError({ message: "Aperture URL must use HTTP or HTTPS" });
  }
  return url.origin;
});

export const connectionOriginPattern = (input: string) =>
  normalizeConnectionOrigin(input).pipe(Effect.map((origin) => `${origin}/*`));

export const requestConnectionPermission = (input: string) =>
  connectionOriginPattern(input).pipe(
    Effect.flatMap((pattern) =>
      requestOrigins([pattern], "Access to the Aperture instance was not granted"),
    ),
  );

/** Checks the token against the instance, then stores the connection and makes it active. */
export const connect = Effect.fn("connect")(function* (originInput: string, tokenInput: string) {
  const origin = yield* normalizeConnectionOrigin(originInput);
  const token = tokenInput.trim();
  if (token === "") return yield* new CompanionError({ message: "API token is required" });

  const provisional: ApiCredentials = {
    kind: "bearer",
    token,
    authorityType: null,
    tenantId: null,
    selectedTenantId: null,
  };
  const verified = yield* Effect.gen(function* () {
    const auth = yield* AuthApi.use((api) => api.getAuthMe(null, provisional));
    if (auth.selectedTenant === null) {
      return yield* new CompanionError({ message: "The Aperture token has no active tenant" });
    }
    const authenticated = {
      ...provisional,
      authorityType: auth.principal.authorityType,
      tenantId: auth.principal.tenantId ?? null,
      selectedTenantId:
        auth.principal.authorityType === "system_admin" ? auth.selectedTenant.id : null,
    } satisfies ApiCredentials;
    const { channels } = yield* SessionsApi.use((api) => api.getBrowserChannels(authenticated));
    return {
      authenticated,
      tenantName: auth.selectedTenant.displayName,
      scopes: auth.principal.scopes,
      channels: channels.map(({ name }) => name),
    };
  }).pipe(withApi(origin));

  const { authenticated, channels } = verified;
  const [channel] = channels;
  if (channel === undefined) {
    return yield* new CompanionError({ message: "Aperture offers no browser channels" });
  }
  const connection: Connection = {
    id: crypto.randomUUID(),
    origin,
    token,
    authorityType: authenticated.authorityType,
    tenantId: authenticated.tenantId,
    selectedTenantId: authenticated.selectedTenantId,
    tenantName: verified.tenantName,
    channel,
    channels,
    scopes: verified.scopes,
  };
  const store = yield* loadStore;
  yield* connectionStore.set({
    connections: [...store.connections, connection],
    activeConnectionId: connection.id,
  });
  yield* connectionDraft.remove;
  return connection;
});

export const listConnections = loadStore.pipe(Effect.map((store) => store.connections));

export const activeConnection = loadStore.pipe(
  Effect.map(
    (store) => store.connections.find(({ id }) => id === store.activeConnectionId) ?? null,
  ),
);

/** The active connection; fails when there is none. */
export const requireActiveConnection = activeConnection.pipe(
  Effect.flatMap((connection) =>
    connection === null
      ? Effect.fail(new CompanionError({ message: "Aperture is not connected" }))
      : Effect.succeed(connection),
  ),
);

export const selectConnection = Effect.fnUntraced(function* (id: string) {
  const store = yield* loadStore;
  if (!store.connections.some((connection) => connection.id === id)) return yield* unavailable;
  yield* connectionStore.set({ ...store, activeConnectionId: id });
});

export const saveConnection = Effect.fnUntraced(function* (connection: Connection) {
  const store = yield* loadStore;
  if (!store.connections.some(({ id }) => id === connection.id)) return yield* unavailable;
  yield* connectionStore.set({
    ...store,
    connections: store.connections.map((current) =>
      current.id === connection.id ? connection : current,
    ),
  });
});

/** Removes a connection; the first remaining one becomes active if it was. */
export const removeConnection = Effect.fnUntraced(function* (id: string) {
  const store = yield* loadStore;
  const connections = store.connections.filter((connection) => connection.id !== id);
  yield* connectionStore.set({
    connections,
    activeConnectionId:
      store.activeConnectionId === id ? (connections[0]?.id ?? null) : store.activeConnectionId,
  });
});

/** Moves a connection before or after another one and returns the new order. */
export const reorderConnection = Effect.fnUntraced(function* (
  sourceId: string,
  destinationId: string,
  placement: "before" | "after",
) {
  const store = yield* loadStore;
  const moved = store.connections.find(({ id }) => id === sourceId);
  if (moved === undefined || sourceId === destinationId) return store.connections;

  const connections = store.connections.filter(({ id }) => id !== sourceId);
  const destinationIndex = connections.findIndex(({ id }) => id === destinationId);
  if (destinationIndex === -1) return store.connections;
  connections.splice(destinationIndex + (placement === "after" ? 1 : 0), 0, moved);

  if (connections.every(({ id }, index) => id === store.connections[index]?.id)) {
    return store.connections;
  }
  yield* connectionStore.set({ ...store, connections });
  return connections;
});

export function hasScope(connection: Connection, scope: string): boolean {
  return connection.scopes.includes("system:admin") || connection.scopes.includes(scope);
}

export function connectionLabel(connection: Connection): string {
  return `${connection.tenantName} · ${new URL(connection.origin).host}`;
}

/** Names of every snapshot the connection can start sessions from. */
export const listSnapshots = Effect.fn("listSnapshots")(
  function* (connection: Connection) {
    const api = yield* SnapshotsApi;
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const page = yield* api.listSnapshots(credentials(connection), { limit: 100, cursor });
      names.push(...page.data.map(({ name }) => name));
      cursor = page.meta.hasMore ? page.meta.nextCursor : undefined;
    } while (cursor !== undefined);
    return names;
  },
  (effect, connection) => withApi(connection.origin)(effect),
);

export interface CreateSessionOptions {
  readonly targets: readonly InitialBrowserTarget[];
  readonly storageState?: InitialBrowserStorageState;
  readonly baseSnapshotName?: string;
  readonly label?: string;
  readonly tags?: Tags;
  readonly waitForReady?: boolean;
}

/** Creates a session that starts from the captured state and returns its ID. */
export const createSession = Effect.fn("createSession")(
  function* (connection: Connection, options: CreateSessionOptions) {
    const api = yield* SessionsApi;
    const label = options.label?.trim();
    const result = yield* api.createSession(
      credentials(connection),
      {
        browser: { channel: connection.channel, args: [] },
        initialTargets: options.targets,
        storageState: options.storageState,
        baseSnapshotName: options.baseSnapshotName || null,
        label: label || null,
        tags: options.tags,
      },
      { waitForReady: options.waitForReady },
    );
    return result.session.id;
  },
  (effect, connection) => withApi(connection.origin)(effect),
);

export interface PromoteSessionOptions {
  readonly name: string;
  readonly description: string;
  readonly tags: Tags;
}

/** Stops the session and keeps its state as a snapshot. */
export const promoteSession = Effect.fn("promoteSession")(
  function* (connection: Connection, sessionId: string, options: PromoteSessionOptions) {
    const api = yield* SessionsApi;
    yield* api.deleteSession(credentials(connection), sessionId);
    yield* api.promoteSession(credentials(connection), sessionId, {
      name: options.name.trim(),
      description: options.description.trim() || null,
      force: true,
      tags: options.tags,
    });
  },
  (effect, connection) => withApi(connection.origin)(effect),
);

export const openWorkbench = (connection: Connection, sessionId: string) =>
  openTab(`${connection.origin}/-/sessions/${encodeURIComponent(sessionId)}`);

export const openSnapshots = (connection: Connection) =>
  openTab(`${connection.origin}/-/snapshots/`);
