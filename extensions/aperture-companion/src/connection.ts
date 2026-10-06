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
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { withApi } from "./api.ts";
import { CompanionError, openTab, requestOrigins, withExtensionLock } from "./chrome.ts";
import { AuthenticationMethod, OAuthSession, authorize, refresh, revoke } from "./oauth.ts";
import { NonEmptyString, type Tags } from "./schema.ts";
import { storedValue } from "./storage.ts";
import * as UrlPath from "./url-path.ts";

/** An Aperture instance and its locally stored credentials. */
export const Connection = Schema.Struct({
  id: NonEmptyString,
  origin: NonEmptyString,
  token: Schema.RedactedFromValue(NonEmptyString),
  oauth: Schema.optionalKey(OAuthSession),
  authorityType: Schema.Literals(["system_admin", "tenant"]),
  tenantId: Schema.NullOr(Schema.String),
  selectedTenantId: Schema.NullOr(Schema.String),
  tenantName: Schema.String,
  channel: NonEmptyString,
  channels: Schema.Array(NonEmptyString).check(Schema.isMinLength(1)),
  scopes: Schema.Array(Schema.String),
});
export type Connection = typeof Connection.Type;

export const ConnectionDraft = Schema.Struct({
  origin: Schema.String,
  token: Schema.String,
  method: AuthenticationMethod,
});
export type ConnectionDraft = typeof ConnectionDraft.Type;

const ConnectionStore = Schema.Struct({
  connections: Schema.Array(Connection),
  activeConnectionId: Schema.NullOr(Schema.String),
});

// Tokens stay in local storage, which Chromium never synchronizes.
const connectionStore = storedValue("local", "apertureConnections", ConnectionStore);

/** The add-connection form, kept while the popup closes for the permission prompt. */
export const connectionDraft = storedValue("session", "apertureConnectionDraft", ConnectionDraft);

export const emptyConnectionDraft: ConnectionDraft = { origin: "", token: "", method: "oauth" };

const loadStore = connectionStore.get.pipe(
  Effect.map(Option.getOrElse(() => ({ connections: [], activeConnectionId: null }))),
);

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

const verifyConnection = Effect.fn("verifyConnection")(function* (
  origin: string,
  token: Redacted.Redacted<string>,
  oauth?: OAuthSession,
) {
  const provisional: ApiCredentials = {
    kind: "bearer",
    token,
    authorityType: null,
    tenantId: null,
    selectedTenantId: null,
  };
  const verified = yield* Effect.gen(function* () {
    let auth = yield* AuthApi.use((api) => api.getAuthMe(null, provisional));
    if (auth.selectedTenant === null && oauth !== undefined) {
      const tenant = auth.availableTenants[0];
      if (tenant !== undefined) {
        auth = yield* AuthApi.use((api) => api.getAuthMe(tenant.id, provisional));
      }
    }
    if (auth.selectedTenant === null) {
      return yield* new CompanionError({ message: "The Aperture connection has no active tenant" });
    }
    if (
      oauth !== undefined &&
      auth.principal.authorityType !== "system_admin" &&
      (!auth.principal.scopes.includes("sessions:read") ||
        !auth.principal.scopes.includes("sessions:write"))
    ) {
      return yield* new CompanionError({
        message: "Approve sessions:read and sessions:write to connect Aperture Companion",
      });
    }
    const authenticated = {
      ...provisional,
      authorityType: auth.principal.authorityType,
      tenantId: auth.principal.tenantId ?? null,
      selectedTenantId:
        auth.principal.authorityType === "system_admin" || oauth !== undefined
          ? auth.selectedTenant.id
          : null,
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
    ...(oauth === undefined ? {} : { oauth }),
    authorityType: authenticated.authorityType,
    tenantId: authenticated.tenantId,
    selectedTenantId: authenticated.selectedTenantId,
    tenantName: verified.tenantName,
    channel,
    channels,
    scopes: verified.scopes,
  };
  yield* withExtensionLock(
    "apertureConnections",
    Effect.gen(function* () {
      const store = yield* loadStore;
      yield* connectionStore.set({
        connections: [...store.connections, connection],
        activeConnectionId: connection.id,
      });
    }),
  );
  yield* connectionDraft.remove;
  return connection;
});

/** Checks a manually supplied API token before saving it. */
export const connect = Effect.fn("connect")(function* (originInput: string, tokenInput: string) {
  const origin = yield* normalizeConnectionOrigin(originInput);
  const trimmedToken = tokenInput.trim();
  if (trimmedToken === "") return yield* new CompanionError({ message: "API token is required" });
  return yield* verifyConnection(origin, Redacted.make(trimmedToken));
});

export const connectWithOAuth = Effect.fn("connectWithOAuth")(function* (originInput: string) {
  const origin = yield* normalizeConnectionOrigin(originInput);
  const authorization = yield* authorize(origin);
  return yield* verifyConnection(origin, authorization.token, authorization.oauth).pipe(
    Effect.tapCause(() => Effect.ignore(revoke(authorization.oauth))),
  );
});

/** Reloads credentials under the shared lock before rotating an expiring refresh token. */
export const freshConnection = (id: string) =>
  withExtensionLock(
    "apertureConnections",
    Effect.gen(function* () {
      const store = yield* loadStore;
      const connection = store.connections.find((candidate) => candidate.id === id);
      if (connection === undefined)
        return yield* new CompanionError({ message: "The Aperture connection is unavailable" });
      if (connection.oauth === undefined || Date.now() + 60_000 < connection.oauth.expiresAt)
        return connection;
      const refreshed = { ...connection, ...(yield* refresh(connection.oauth)) };
      yield* connectionStore.set({
        ...store,
        connections: store.connections.map((current) => (current.id === id ? refreshed : current)),
      });
      return refreshed;
    }),
  );

export const listConnections = loadStore.pipe(Effect.map((store) => store.connections));

const credentials = Effect.fn("credentials")(function* (stored: Connection) {
  const connection = yield* freshConnection(stored.id);
  return {
    kind: "bearer",
    token: connection.token,
    authorityType: connection.authorityType,
    tenantId: connection.tenantId,
    selectedTenantId: connection.selectedTenantId,
  } satisfies ApiCredentials;
});

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

export const selectConnection = Effect.fn("selectConnection")(function* (id: string) {
  yield* withExtensionLock(
    "apertureConnections",
    Effect.gen(function* () {
      const store = yield* loadStore;
      if (!store.connections.some((connection) => connection.id === id)) {
        return yield* new CompanionError({ message: "The Aperture connection is unavailable" });
      }
      yield* connectionStore.set({ ...store, activeConnectionId: id });
    }),
  );
});

export const saveChannel = Effect.fn("saveChannel")(function* (id: string, channel: string) {
  yield* withExtensionLock(
    "apertureConnections",
    Effect.gen(function* () {
      const store = yield* loadStore;
      if (
        !store.connections.some(
          (connection) => connection.id === id && connection.channels.includes(channel),
        )
      ) {
        return yield* new CompanionError({ message: "The Aperture connection is unavailable" });
      }
      yield* connectionStore.set({
        ...store,
        connections: store.connections.map((current) =>
          current.id === id ? { ...current, channel } : current,
        ),
      });
    }),
  );
});

/** Removes a connection; the first remaining one becomes active if it was. */
export const removeConnection = Effect.fn("removeConnection")(function* (id: string) {
  yield* withExtensionLock(
    "apertureConnections",
    Effect.gen(function* () {
      const store = yield* loadStore;
      const removed = store.connections.find((connection) => connection.id === id);
      if (removed?.oauth !== undefined) yield* revoke(removed.oauth);
      const connections = store.connections.filter((connection) => connection.id !== id);
      yield* connectionStore.set({
        connections,
        activeConnectionId:
          store.activeConnectionId === id ? (connections[0]?.id ?? null) : store.activeConnectionId,
      });
    }),
  );
});

export type Placement = "before" | "after";

/** Moves a connection before or after another one and returns the new order. */
export const reorderConnection = Effect.fn("reorderConnection")(function* (
  sourceId: string,
  destinationId: string,
  placement: Placement,
) {
  return yield* withExtensionLock(
    "apertureConnections",
    Effect.gen(function* () {
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
    }),
  );
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
    const authenticated = yield* credentials(connection);
    const snapshots = yield* api.listAllSnapshots(authenticated, { limit: 100 });
    return snapshots.map(({ name }) => name);
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
    const authenticated = yield* credentials(connection);
    const label = options.label?.trim();
    const result = yield* api.createSession(
      authenticated,
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
    yield* api.deleteSession(yield* credentials(connection), sessionId);
    yield* api.promoteSession(yield* credentials(connection), sessionId, {
      name: options.name.trim(),
      description: options.description.trim() || null,
      force: false,
      tags: options.tags,
    });
  },
  (effect, connection) => withApi(connection.origin)(effect),
);

export const openWorkbench = (connection: Connection, sessionId: string) =>
  openTab(UrlPath.make`${UrlPath.raw(connection.origin)}/-/sessions/${sessionId}`);

export const openSnapshots = (connection: Connection) =>
  openTab(UrlPath.make`${UrlPath.raw(connection.origin)}/-/snapshots/`);
