import type { MessageInitShape } from "@bufbuild/protobuf";
import { createClient, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ExecutorError } from "./errors.ts";
import {
  type CreateSessionRequestSchema,
  type CreateSnapshotRequestSchema,
  ExecutorService,
  type LimitsSchema,
  type ProxyConfigSchema,
} from "./gen/aperture/executor/v1/executor_pb.ts";

/** Where an executor is and what lets a caller in. */
export interface Address {
  /** The executor's base, such as `https://node.example`. */
  readonly url: string;
  /** The operator token. */
  readonly token: string;
}

export type CreateSession = MessageInitShape<typeof CreateSessionRequestSchema>;
export type CreateSnapshot = MessageInitShape<typeof CreateSnapshotRequestSchema>;
export type ProxyConfigInit = MessageInitShape<typeof ProxyConfigSchema>;
export type LimitsInit = MessageInitShape<typeof LimitsSchema>;

// The executor always sends the message a response is made for.
const sent = <A>(value: A | undefined, what: string) =>
  value === undefined
    ? Effect.fail(
        new ExecutorError({ code: "internal", message: `the executor's answer has no ${what}` }),
      )
    : Effect.succeed(value);

const asked = <A>(call: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: call, catch: (cause) => ExecutorError.from(cause) });

/** One executor's client. */
export const make = (address: Address) => {
  const authorized: Interceptor = (next) => (request) => {
    request.header.set("Authorization", `Bearer ${address.token}`);
    return next(request);
  };
  const client = createClient(
    ExecutorService,
    createConnectTransport({
      baseUrl: address.url.replace(/\/+$/u, ""),
      interceptors: [authorized],
    }),
  );
  return {
    /** What the executor is and what its sessions may have. */
    get: asked((signal) => client.getExecutor({}, { signal })).pipe(
      Effect.flatMap((response) => sent(response.executor, "executor")),
    ),
    sessions: {
      /** Creates a session, from a snapshot or empty, and starts its browser unless asked not to. */
      create: (request: CreateSession = {}) =>
        asked((signal) => client.createSession(request, { signal })).pipe(
          Effect.flatMap((response) => sent(response.session, "session")),
        ),
      get: (id: string) =>
        asked((signal) => client.getSession({ id }, { signal })).pipe(
          Effect.flatMap((response) => sent(response.session, "session")),
        ),
      list: asked((signal) => client.listSessions({}, { signal })).pipe(
        Effect.map((response) => response.sessions),
      ),
      /** Stops the session's browser and keeps its profile. */
      suspend: (id: string) =>
        asked((signal) => client.suspendSession({ id }, { signal })).pipe(
          Effect.flatMap((response) => sent(response.session, "session")),
        ),
      /**
       * Starts the browser of a suspended or failed session on the profile it left. As a
       * takeover, also when another node says it has the session.
       */
      resume: (id: string, options: { readonly takeover?: boolean } = {}) =>
        asked((signal) =>
          client.resumeSession({ id, takeover: options.takeover ?? false }, { signal }),
        ).pipe(Effect.flatMap((response) => sent(response.session, "session"))),
      /**
       * Sets how the session's browser connections are routed. Without a configuration,
       * everything goes direct again.
       */
      setProxy: (id: string, proxy?: ProxyConfigInit) =>
        asked((signal) =>
          client.updateSessionProxy(proxy === undefined ? { id } : { id, proxy }, { signal }),
        ).pipe(Effect.asVoid),
      /**
       * Sets the session's own limits in place of those it had: one left out is the
       * executor's, and zero is none. How long it may sit idle holds at once; what it may
       * use holds from when its browser next starts.
       */
      setLimits: (id: string, limits: LimitsInit) =>
        asked((signal) => client.updateSessionLimits({ id, limits }, { signal })).pipe(
          Effect.asVoid,
        ),
      /** Stops the session and removes its profile and files. Snapshots taken of it stay. */
      delete: (id: string) =>
        asked((signal) => client.deleteSession({ id }, { signal })).pipe(Effect.asVoid),
      /**
       * The node's sessions as they change: each as it is now, then each again when what
       * `get` tells of it becomes another, and the id of each that is gone. It goes on
       * until whoever runs the stream stops.
       */
      watch: Stream.suspend(() => {
        const leaving = new AbortController();
        const events = client.watchSessions({}, { signal: leaving.signal });
        return Stream.fromAsyncIterable(events, (cause) => ExecutorError.from(cause)).pipe(
          Stream.ensuring(Effect.sync(() => leaving.abort())),
        );
      }),
      /**
       * Drops the node's copy of a session that is at rest where nodes share sessions: the
       * session stays there, for whichever node resumes it.
       */
      evict: (id: string) =>
        asked((signal) => client.evictSession({ id }, { signal })).pipe(Effect.asVoid),
      /** The sessions where nodes share them, whichever node has them or none. */
      stored: asked((signal) => client.listStoredSessions({}, { signal })).pipe(
        Effect.map((response) => response.sessions),
      ),
    },
    snapshots: {
      /** Keeps the session's profile as it is now. */
      create: (request: CreateSnapshot) =>
        asked((signal) => client.createSnapshot(request, { signal })).pipe(
          Effect.flatMap((response) => sent(response.snapshot, "snapshot")),
        ),
      get: (id: string) =>
        asked((signal) => client.getSnapshot({ id }, { signal })).pipe(
          Effect.flatMap((response) => sent(response.snapshot, "snapshot")),
        ),
      list: asked((signal) => client.listSnapshots({}, { signal })).pipe(
        Effect.map((response) => response.snapshots),
      ),
      /** Sessions created from the snapshot keep working. */
      delete: (id: string) =>
        asked((signal) => client.deleteSnapshot({ id }, { signal })).pipe(Effect.asVoid),
    },
  };
};

export type ExecutorClient = ReturnType<typeof make>;

/** One executor's client, for programs that pass it along as a service. */
export class Executor extends Context.Service<Executor, ExecutorClient>()(
  "@aperture-browser/executor-client/Executor",
) {}

export const layer = (address: Address) => Layer.succeed(Executor, make(address));
