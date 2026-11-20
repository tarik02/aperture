import type { MessageInitShape } from "@bufbuild/protobuf";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type Address, call } from "./call.ts";
import { ExecutorError } from "./errors.ts";
import {
  type CreateSessionRequestSchema,
  type CreateSnapshotRequestSchema,
  ExecutorService,
  type ProxyConfigSchema,
} from "./gen/aperture/executor/v1/executor_pb.ts";

export type CreateSession = MessageInitShape<typeof CreateSessionRequestSchema>;
export type CreateSnapshot = MessageInitShape<typeof CreateSnapshotRequestSchema>;
export type ProxyConfigInit = MessageInitShape<typeof ProxyConfigSchema>;

const methods = ExecutorService.method;

// The executor always sends the message a response is made for.
const sent = <A>(value: A | undefined, what: string) =>
  value === undefined
    ? Effect.fail(
        new ExecutorError({ code: "internal", message: `the executor's answer has no ${what}` }),
      )
    : Effect.succeed(value);

/** One executor's client. */
export const make = (address: Address) => ({
  /** What the executor is and what its sessions may have. */
  get: call(address, methods.getExecutor, {}).pipe(
    Effect.flatMap((response) => sent(response.executor, "executor")),
  ),
  sessions: {
    /** Creates a session, from a snapshot or empty, and starts its browser unless asked not to. */
    create: (request: CreateSession = {}) =>
      call(address, methods.createSession, request).pipe(
        Effect.flatMap((response) => sent(response.session, "session")),
      ),
    get: (id: string) =>
      call(address, methods.getSession, { id }).pipe(
        Effect.flatMap((response) => sent(response.session, "session")),
      ),
    list: call(address, methods.listSessions, {}).pipe(Effect.map((response) => response.sessions)),
    /** Stops the session's browser and keeps its profile. */
    suspend: (id: string) =>
      call(address, methods.suspendSession, { id }).pipe(
        Effect.flatMap((response) => sent(response.session, "session")),
      ),
    /**
     * Starts the browser of a suspended or failed session on the profile it left. As a
     * takeover, also when another node says it has the session.
     */
    resume: (id: string, options: { readonly takeover?: boolean } = {}) =>
      call(address, methods.resumeSession, { id, takeover: options.takeover ?? false }).pipe(
        Effect.flatMap((response) => sent(response.session, "session")),
      ),
    /**
     * Sets how the session's browser connections are routed. Without a configuration,
     * everything goes direct again.
     */
    setProxy: (id: string, proxy?: ProxyConfigInit) =>
      call(address, methods.updateSessionProxy, proxy === undefined ? { id } : { id, proxy }).pipe(
        Effect.asVoid,
      ),
    /** Stops the session and removes its profile and files. Snapshots taken of it stay. */
    delete: (id: string) => call(address, methods.deleteSession, { id }).pipe(Effect.asVoid),
  },
  snapshots: {
    /** Keeps the session's profile as it is now. */
    create: (request: CreateSnapshot) =>
      call(address, methods.createSnapshot, request).pipe(
        Effect.flatMap((response) => sent(response.snapshot, "snapshot")),
      ),
    get: (id: string) =>
      call(address, methods.getSnapshot, { id }).pipe(
        Effect.flatMap((response) => sent(response.snapshot, "snapshot")),
      ),
    list: call(address, methods.listSnapshots, {}).pipe(
      Effect.map((response) => response.snapshots),
    ),
    /** Sessions created from the snapshot keep working. */
    delete: (id: string) => call(address, methods.deleteSnapshot, { id }).pipe(Effect.asVoid),
  },
});

export type ExecutorClient = ReturnType<typeof make>;

/** One executor's client, for programs that pass it along as a service. */
export class Executor extends Context.Service<Executor, ExecutorClient>()(
  "@aperture-browser/executor-client/Executor",
) {}

export const layer = (address: Address) => Layer.succeed(Executor, make(address));
