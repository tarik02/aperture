import type { Access, Caller, ProxyConfig } from "@aperture-browser/control-api";
import type { ExecutorError, proto } from "@aperture-browser/executor-client";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import type {
  FileLinkInvalid,
  Forbidden,
  NodeRefused,
  NodeUnreachable,
  NoNode,
  QuotaExceeded,
  SessionHasNoNode,
  SessionNotFound,
  SnapshotNotFound,
  WorkspaceNotFound,
} from "../errors.ts";
import type { Reach } from "../accounts/caller.ts";
import type { Node } from "../nodes/schemas.ts";
import type { Admission, FileLink, Session } from "./schemas.ts";
import type { ExpiryDue, SessionDescription } from "./store.ts";

export interface NewSessionOptions {
  readonly suspended: boolean;
  readonly snapshotId: string | undefined;
  readonly label: string | undefined;
  /** The workspace the session is of; the caller's own account's without. */
  readonly workspaceId: string | undefined;
  readonly proxy: ProxyConfig | undefined;
  readonly tags: Readonly<Record<string, string>>;
  /** What the session's browser starts with, as its node takes it. */
  readonly storageState: unknown;
}

/** What asking a session's node for something may come to. */
export type NodeError = SessionNotFound | SessionHasNoNode | NodeUnreachable | NodeRefused;
/** What acting on a session through its node may come to: an admin who only sees it is refused. */
export type ActError = NodeError | Forbidden;

/** Why a session was deleted by itself: for being too old, or suspended too long. */
export interface ExpiryReasons {
  readonly aged: string;
  readonly suspended: string;
}

/** Sessions wherever they run: what their owners ask of them, and what their nodes say of them. */
export interface SessionsShape {
  /**
   * Creates a session for the caller's account on a node that is alive, the one with the
   * fewest sessions first, and the next where that one does not answer. One created from
   * a snapshot goes to a node that has the snapshot: any that shares snapshots where it
   * is shared, and the node it was taken on otherwise. A storage state the node does not
   * take makes no session.
   */
  readonly create: (
    caller: Caller,
    options: NewSessionOptions,
  ) => Effect.Effect<
    Session,
    Forbidden | WorkspaceNotFound | SnapshotNotFound | NoNode | NodeRefused | QuotaExceeded
  >;
  /** Changes what its owner calls a session and tags it with; what is left out stays. */
  readonly describe: (
    caller: Caller,
    id: string,
    said: SessionDescription,
  ) => Effect.Effect<Session, SessionNotFound | Forbidden>;
  /** The caller's own sessions; all of them for an admin. */
  readonly list: (caller: Caller) => Effect.Effect<ReadonlyArray<Session>>;
  readonly get: (caller: Caller, id: string) => Effect.Effect<Session, SessionNotFound>;
  /**
   * The caller's session and the node it is on, for what is asked of that node: one they
   * see, or one they act on, which an admin who only sees it is refused.
   */
  readonly placed: (
    caller: Caller,
    id: string,
    reach: Reach,
  ) => Effect.Effect<
    { readonly session: Session; readonly node: Node },
    SessionNotFound | SessionHasNoNode | Forbidden
  >;
  /** The caller's session to act on, which an admin who only sees it is refused. */
  readonly acted: (
    caller: Caller,
    id: string,
  ) => Effect.Effect<Session, SessionNotFound | Forbidden>;
  /** A session's routing as it was last set here; none where everything goes direct. */
  readonly proxy: (
    caller: Caller,
    id: string,
  ) => Effect.Effect<ProxyConfig | null, SessionNotFound>;
  /** Sets how the session's browser connections are routed; with none, all go direct. */
  readonly setProxy: (
    caller: Caller,
    id: string,
    proxy: ProxyConfig | null,
  ) => Effect.Effect<void, ActError>;
  readonly suspend: (caller: Caller, id: string) => Effect.Effect<Session, ActError>;
  /** Resumes a session, unless as many of its kind run as its settings let. */
  readonly resume: (caller: Caller, id: string) => Effect.Effect<Session, ActError | QuotaExceeded>;
  readonly delete: (caller: Caller, id: string) => Effect.Effect<void, ActError>;
  /**
   * Deletes a session by itself, as its settings say, if it is still due to go when it is
   * deleted: on its node where it is on one, and its record. Whether it was deleted.
   */
  readonly expire: (
    id: string,
    due: ExpiryDue,
    reasons: ExpiryReasons,
  ) => Effect.Effect<boolean, NodeUnreachable | NodeRefused>;
  /**
   * Pins a session, which keeps it from being deleted by itself, or unpins it: for whom
   * its settings let pin, and as many as they let be pinned.
   */
  readonly pin: (
    caller: Caller,
    id: string,
    pinned: boolean,
  ) => Effect.Effect<Session, SessionNotFound | Forbidden | QuotaExceeded>;
  /**
   * A ticket for the caller's account into the session, and the session's workbench with
   * it: on its node where that has an address of its own, and otherwise below `origin`,
   * where the proxy before the nodes is.
   */
  readonly admit: (
    caller: Caller,
    id: string,
    options: { readonly name: string | undefined; readonly access: Access },
    origin: string,
  ) => Effect.Effect<Admission, Forbidden | SessionNotFound | SessionHasNoNode>;
  /**
   * An address one file of the session is read at, or one of its uploads is put to, by
   * whoever is given it and for a short while: the ticket in it is good there alone.
   */
  readonly fileLink: (
    caller: Caller,
    id: string,
    asked: {
      /** Below the session's files: `recordings/1a2b.mkv`. */
      readonly path: string;
      readonly write: boolean;
      readonly lasts: Duration.Duration | undefined;
    },
    origin: string,
  ) => Effect.Effect<FileLink, Forbidden | SessionNotFound | SessionHasNoNode | FileLinkInvalid>;
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
