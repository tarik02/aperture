import { covers, type Scope } from "@aperture-browser/control-api";
import * as Client from "@aperture-browser/control-api/client";
import * as UrlPath from "@aperture-browser/shared/url-path";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { CompanionError, openTab, requestOrigins, withExtensionLock } from "./chrome.ts";
import { AuthenticationMethod, OAuthSession, authorize, refresh, revoke } from "./oauth.ts";
import { NonEmptyString, type Tags } from "./schema.ts";
import type { StorageState } from "./state.ts";
import { storedValue } from "./storage.ts";

/**
 * Where a connection's sessions and snapshots are made: a workspace, or, with no id, the
 * account's own.
 */
export const Place = Schema.Struct({ id: Schema.NullOr(NonEmptyString), name: Schema.String });
export type Place = typeof Place.Type;

/** An Aperture control plane and what is kept here to call it with. */
export const Connection = Schema.Struct({
  id: NonEmptyString,
  origin: NonEmptyString,
  token: Schema.RedactedFromValue(NonEmptyString),
  oauth: Schema.optionalKey(OAuthSession),
  accountName: Schema.String,
  /** What the token is held to; none for one that does whatever its account does. */
  scopes: Schema.NullOr(Schema.Array(Schema.String)),
  places: Schema.Array(Place).check(Schema.isMinLength(1)),
  /** The place that is made in, one of `places`. */
  placeId: Schema.NullOr(NonEmptyString),
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
    Effect.flatMap((pattern) => requestOrigins([pattern], "connect")),
  );

const httpLayer = Layer.mergeAll(
  FetchHttpClient.layer,
  Layer.succeed(FetchHttpClient.RequestInit, { credentials: "omit", cache: "no-store" }),
  Layer.succeed(HttpClient.TracerPropagationEnabled, false),
);

const EXPIRED = "Aperture access expired or was revoked. Remove this connection and connect again.";

/** What a failed call is told to the user as: the control plane's own words where it has any. */
const told = (error: unknown) => {
  if (error instanceof CompanionError) return error;
  const tag = typeof error === "object" && error !== null && "_tag" in error ? error._tag : "";
  if (tag === "Unauthorized") return new CompanionError({ message: EXPIRED });
  if (tag === "HttpClientError") {
    return new CompanionError({ message: "Could not reach Aperture" });
  }
  if (tag === "SchemaError" || tag === "HttpApiSchemaError") {
    return new CompanionError({ message: "Aperture answered what this extension does not read" });
  }
  const said = error instanceof Error ? error.message.trim() : "";
  return new CompanionError({
    message: said === "" ? "Aperture refused the request" : `Aperture: ${said}`,
  });
};

/** Calls the control plane at `origin` with `token`. */
const calling = <A, E>(
  origin: string,
  token: Redacted.Redacted<string>,
  call: (api: Client.Client) => Effect.Effect<A, E>,
) =>
  Client.make({ baseUrl: origin, token: Redacted.value(token) }).pipe(
    Effect.flatMap(call),
    Effect.mapError(told),
    Effect.provide(httpLayer),
  );

const PERSONAL = "Personal";

const verifyConnection = Effect.fn("verifyConnection")(function* (
  origin: string,
  token: Redacted.Redacted<string>,
  oauth?: OAuthSession,
) {
  const { account, workspaces } = yield* calling(origin, token, (api) =>
    Effect.all(
      { account: api.accounts.current(), workspaces: api.workspaces.list() },
      { concurrency: "unbounded" },
    ),
  );
  if (!covers(account.scopes, "sessions:write")) {
    return yield* new CompanionError({
      message:
        oauth === undefined
          ? "The API token needs the sessions:write scope"
          : "Approve sessions:write to connect Aperture Companion",
    });
  }
  // A token held to resources makes sessions in the workspaces it names and nowhere else.
  const places: Place[] = [
    ...(account.resources === null ? [{ id: null, name: PERSONAL }] : []),
    ...workspaces.filter(({ role }) => role !== null).map(({ id, name }) => ({ id, name })),
  ];
  const [first] = places;
  if (first === undefined) {
    return yield* new CompanionError({
      message: "This access reaches no workspace to make sessions in",
    });
  }
  const connection: Connection = {
    id: crypto.randomUUID(),
    origin,
    token,
    ...(oauth === undefined ? {} : { oauth }),
    accountName: account.name,
    scopes: account.scopes,
    places,
    placeId: first.id,
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

export const savePlace = Effect.fn("savePlace")(function* (id: string, placeId: string | null) {
  yield* withExtensionLock(
    "apertureConnections",
    Effect.gen(function* () {
      const store = yield* loadStore;
      if (
        !store.connections.some(
          (connection) =>
            connection.id === id && connection.places.some((place) => place.id === placeId),
        )
      ) {
        return yield* new CompanionError({ message: "The Aperture connection is unavailable" });
      }
      yield* connectionStore.set({
        ...store,
        connections: store.connections.map((current) =>
          current.id === id ? { ...current, placeId } : current,
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

export function hasScope(connection: Connection, scope: Scope): boolean {
  return covers(connection.scopes as ReadonlyArray<Scope> | null, scope);
}

export function connectionLabel(connection: Connection): string {
  return `${connection.accountName} · ${new URL(connection.origin).host}`;
}

/** Calls the control plane as the connection, with a token that is still good. */
const asConnection = <A, E>(
  stored: Connection,
  call: (api: Client.Client) => Effect.Effect<A, E>,
) =>
  freshConnection(stored.id).pipe(
    Effect.flatMap((connection) => calling(connection.origin, connection.token, call)),
  );

/** What a list of snapshots is narrowed to for a place. */
const inPlace = (connection: Connection) => connection.placeId ?? "none";

/** A snapshot a session can start from, as the popup offers it. */
export const BaseSnapshot = Schema.Struct({ id: NonEmptyString, name: Schema.String });
export type BaseSnapshot = typeof BaseSnapshot.Type;

/** Every snapshot the connection can start a session from, the newest first. */
export const listSnapshots = Effect.fn("listSnapshots")(function* (connection: Connection) {
  const snapshots = yield* asConnection(connection, (api) => api.snapshots.list({ query: {} }));
  return snapshots
    .toSorted((one, other) => other.createdAt.epochMilliseconds - one.createdAt.epochMilliseconds)
    .map(({ id, name }): BaseSnapshot => ({ id, name: name ?? `Unnamed (${id.slice(0, 8)})` }));
});

/**
 * Fails where the place the connection makes in has a snapshot of the name already: names
 * are what snapshots are found by, and Aperture itself holds nobody to one each.
 */
export const requireSnapshotNameFree = Effect.fn("requireSnapshotNameFree")(function* (
  connection: Connection,
  name: string,
) {
  const alike = yield* asConnection(connection, (api) =>
    api.snapshots.list({ query: { name, workspaceId: inPlace(connection) } }),
  );
  if (alike.some((snapshot) => snapshot.name === name)) {
    return yield* new CompanionError({
      message: `A snapshot named “${name}” exists already. It was left as it is: choose another name.`,
    });
  }
});

export interface CreateSessionOptions {
  readonly storageState: StorageState;
  readonly baseSnapshotId?: string | undefined;
  readonly label?: string | undefined;
  readonly tags?: Tags | undefined;
}

/**
 * Creates a session that starts with the captured state and returns its id. The session
 * is there once this returns, and is being restored: its browser is given the state
 * after, which the session's own page shows.
 */
export const createSession = Effect.fn("createSession")(function* (
  connection: Connection,
  options: CreateSessionOptions,
) {
  const label = options.label?.trim();
  const session = yield* asConnection(connection, (api) =>
    api.sessions.create({
      payload: {
        ...(connection.placeId === null ? {} : { workspaceId: connection.placeId }),
        ...(options.baseSnapshotId ? { snapshotId: options.baseSnapshotId } : {}),
        ...(label ? { label } : {}),
        ...(options.tags === undefined ? {} : { tags: options.tags }),
        storageState: options.storageState as unknown as {
          readonly cookies: ReadonlyArray<Record<string, unknown>>;
          readonly origins: ReadonlyArray<Record<string, unknown>>;
          readonly tabs: ReadonlyArray<Record<string, unknown>>;
        },
      },
    }),
  );
  return session.id;
});

/**
 * Waits until the session has all of the state it was created with, which is when it
 * runs. One whose browser did not take the state failed, and says why.
 */
export const waitForRestored = Effect.fn("waitForRestored")(function* (
  connection: Connection,
  sessionId: string,
  deadline: number,
) {
  while (Date.now() < deadline) {
    const session = yield* asConnection(connection, (api) =>
      api.sessions.get({ params: { id: sessionId } }),
    );
    switch (session.observedState) {
      case "running":
        return;
      case "starting":
      case "restoring":
        yield* Effect.sleep("1 second");
        break;
      case "failed":
      case "gone":
      case "suspended":
      case "suspending":
        return yield* new CompanionError({
          message:
            session.failure === null
              ? `The session was not restored (${session.observedState}).`
              : `The session was not restored: ${session.failure}`,
        });
    }
  }
  return yield* new CompanionError({
    message: "Restoring the session took longer than 10 minutes. Check it in Aperture.",
  });
});

/** Whether a snapshot of the session is there: one whose answer was lost was taken all the same. */
export const wasSnapshotTaken = Effect.fn("wasSnapshotTaken")(function* (
  connection: Connection,
  sessionId: string,
) {
  const snapshots = yield* asConnection(connection, (api) => api.snapshots.list({ query: {} }));
  return snapshots.some((snapshot) => snapshot.sessionId === sessionId);
});

export interface TakeSnapshotOptions {
  readonly name: string;
  readonly description: string;
  readonly tags: Tags;
}

/**
 * Stops the session's browser before a snapshot is taken of it: all it was given is in
 * its profile then, and it is not started again for nothing.
 */
export const suspendSession = (connection: Connection, sessionId: string) =>
  asConnection(connection, (api) => api.sessions.suspend({ params: { id: sessionId } })).pipe(
    Effect.asVoid,
  );

/** Takes a snapshot of the session, which is at rest. */
export const takeSnapshot = Effect.fn("takeSnapshot")(function* (
  connection: Connection,
  sessionId: string,
  options: TakeSnapshotOptions,
) {
  const description = options.description.trim();
  yield* asConnection(connection, (api) =>
    api.snapshots.take({
      params: { id: sessionId },
      payload: {
        name: options.name.trim(),
        ...(description === "" ? {} : { description }),
        tags: options.tags,
      },
    }),
  );
});

/** Deletes the session a snapshot was taken of; one that is gone already is deleted. */
export const deleteSession = (connection: Connection, sessionId: string) =>
  asConnection(connection, (api) =>
    api.sessions
      .delete({ params: { id: sessionId } })
      .pipe(Effect.catchTag("SessionNotFound", () => Effect.void)),
  );

export const openWorkbench = (connection: Connection, sessionId: string) =>
  openTab(UrlPath.make`${UrlPath.raw(connection.origin)}/-/sessions/${sessionId}`);

export const openSnapshots = (connection: Connection) =>
  openTab(UrlPath.make`${UrlPath.raw(connection.origin)}/-/snapshots`);
