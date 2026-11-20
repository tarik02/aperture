import type { MessageInitShape } from "@bufbuild/protobuf";
import { createClient, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ExecutorError } from "./errors.ts";
import {
  type CreateSessionRequestSchema,
  type CreateSnapshotRequestSchema,
  ExecutorService,
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

// The executor always sends the message a response is made for.
const sent = <A>(value: A | undefined, what: string) =>
  value === undefined
    ? Effect.fail(
        new ExecutorError({ code: "internal", message: `the executor's answer has no ${what}` }),
      )
    : Effect.succeed(value);

const asked = <A>(call: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: call, catch: ExecutorError.from });

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
      /** Stops the session and removes its profile and files. Snapshots taken of it stay. */
      delete: (id: string) =>
        asked((signal) => client.deleteSession({ id }, { signal })).pipe(Effect.asVoid),
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
