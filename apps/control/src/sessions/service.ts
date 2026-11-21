import type { Access, Caller } from "@aperture-browser/control-api";
import type { ExecutorError, proto } from "@aperture-browser/executor-client";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type {
  Forbidden,
  NodeRefused,
  NodeUnreachable,
  NoNode,
  SessionHasNoNode,
  SessionNotFound,
  SnapshotNotFound,
} from "../errors.ts";
import type { Node } from "../nodes/schemas.ts";
import type { Admission, Session } from "./schemas.ts";
import type { SessionDescription } from "./store.ts";

export interface NewSessionOptions {
  readonly suspended: boolean;
  readonly snapshotId: string | undefined;
  readonly label: string | undefined;
  readonly tags: Readonly<Record<string, string>>;
}

/** What asking a session's node for something may come to. */
export type NodeError = SessionNotFound | SessionHasNoNode | NodeUnreachable | NodeRefused;

/** Sessions wherever they run: what their owners ask of them, and what their nodes say of them. */
export interface SessionsShape {
  /**
   * Creates a session for the caller's account on a node that is alive, the one with the
   * fewest sessions first, and the next where that one does not answer. One created from
   * a snapshot goes to a node that has the snapshot: any that shares snapshots where it
   * is shared, and the node it was taken on otherwise.
   */
  readonly create: (
    caller: Caller,
    options: NewSessionOptions,
  ) => Effect.Effect<Session, Forbidden | SnapshotNotFound | NoNode | NodeRefused>;
  /** Changes what its owner calls a session and tags it with; what is left out stays. */
  readonly describe: (
    caller: Caller,
    id: string,
    said: SessionDescription,
  ) => Effect.Effect<Session, SessionNotFound>;
  /** The caller's own sessions; all of them for an admin. */
  readonly list: (caller: Caller) => Effect.Effect<ReadonlyArray<Session>>;
  readonly get: (caller: Caller, id: string) => Effect.Effect<Session, SessionNotFound>;
  /** The caller's session and the node it is on, for what is asked of that node. */
  readonly placed: (
    caller: Caller,
    id: string,
  ) => Effect.Effect<
    { readonly session: Session; readonly node: Node },
    SessionNotFound | SessionHasNoNode
  >;
  readonly suspend: (caller: Caller, id: string) => Effect.Effect<Session, NodeError>;
  readonly resume: (caller: Caller, id: string) => Effect.Effect<Session, NodeError>;
  readonly delete: (caller: Caller, id: string) => Effect.Effect<void, NodeError>;
  /** A ticket for the caller's account into the session. */
  readonly admit: (
    caller: Caller,
    id: string,
    options: { readonly name: string | undefined; readonly access: Access },
  ) => Effect.Effect<Admission, Forbidden | SessionNotFound | SessionHasNoNode>;
  /** Takes what a node's executor said of one of its sessions. */
  readonly heard: (node: Node, session: proto.Session) => Effect.Effect<void>;
  /** Takes a node's word that it has a session no more. */
  readonly gone: (node: Node, id: string) => Effect.Effect<void>;
  /**
   * Brings the records of a node's sessions to what the node has now: for when the
   * control plane begins to follow it, and missed what happened before.
   */
  readonly reconcile: (node: Node) => Effect.Effect<void, ExecutorError>;
  /** Marks the sessions of a node that does not answer. */
  readonly unreachable: (node: Node) => Effect.Effect<void>;
  /** Marks the sessions of every node but these: the ones that are alive. */
  readonly unreachableExceptOn: (alive: ReadonlyArray<Node>) => Effect.Effect<void>;
}

export class Sessions extends Context.Service<Sessions, SessionsShape>()(
  "@aperture-browser/control/Sessions",
) {}
