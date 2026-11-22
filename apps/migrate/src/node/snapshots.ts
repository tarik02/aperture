import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { NodeStoreUnusable, ProfileNotCopied } from "../errors.ts";

/** A snapshot as a node keeps it, with the profile it is made of. */
export interface NodeSnapshot {
  /** Its id as nodes write ids: 32 hex digits. */
  readonly id: string;
  readonly name: string;
  /** The session it was taken of, which the node need not have. */
  readonly sessionId: string;
  readonly createdAt: Date;
  /** A directory with the whole profile, as the browser left it. */
  readonly profile: string;
}

/**
 * A node's own storage, as its executor reads it: where a snapshot from elsewhere is put
 * so that the node builds sessions on it.
 */
export interface NodeSnapshotsShape {
  /** Whether the directory is a node's store. */
  readonly check: () => Effect.Effect<void, NodeStoreUnusable>;
  /**
   * Puts a snapshot with its profile as one layer. One that is there already is left as it
   * is, and one that was cut short is put again from the start.
   */
  readonly put: (
    snapshot: NodeSnapshot,
  ) => Effect.Effect<void, NodeStoreUnusable | ProfileNotCopied>;
}

export class NodeSnapshots extends Context.Service<NodeSnapshots, NodeSnapshotsShape>()(
  "@aperture-browser/migrate/NodeSnapshots",
) {}
