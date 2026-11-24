import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { NodeStoreUnusable, ProfileNotCopied } from "../errors.ts";

/** A whole profile, as the browser left it, that is to be a layer of a node's. */
export interface NodeLayer {
  /** Its id as nodes write ids: 32 hex digits. */
  readonly id: string;
  /** What it is of, for whoever is told it was not copied. */
  readonly name: string;
  /** A directory with the whole profile. */
  readonly profile: string;
}

/** A snapshot as a node keeps it, with the profile it is made of. */
export interface NodeSnapshot extends NodeLayer {
  /** The session it was taken of, which the node need not have. */
  readonly sessionId: string;
  readonly createdAt: Date;
}

/** A session as a node keeps one that is suspended. */
export interface NodeSession {
  readonly id: string;
  /** What it is called, for whoever is told it was not copied. */
  readonly name: string;
  readonly createdAt: Date;
  /** The snapshot it was created from, where the node has it. */
  readonly snapshotId: string | null;
  /** The layer its profile stands on, which the node has. */
  readonly layer: string | null;
  /** Its routing, as the node's executor reads it. */
  readonly proxy: unknown;
  /** A directory with what its browser wrote above the layer, as overlayfs keeps that. */
  readonly upper: string;
  /** A directory with its files; none for a session that has none. */
  readonly files: string | null;
}

/**
 * A node's own storage, as its executor reads it: where what comes from elsewhere is put
 * so that the node builds sessions on it and resumes them.
 */
export interface NodeStoreShape {
  /** Whether the directory is a node's store. */
  readonly check: () => Effect.Effect<void, NodeStoreUnusable>;
  /**
   * Puts a whole profile as one layer that stands on no other. One that is there already
   * is left as it is, and one that was cut short is put again from the start.
   */
  readonly putLayer: (
    layer: NodeLayer,
  ) => Effect.Effect<void, NodeStoreUnusable | ProfileNotCopied>;
  /** Puts a snapshot with its profile as one layer, as `putLayer` puts a layer. */
  readonly putSnapshot: (
    snapshot: NodeSnapshot,
  ) => Effect.Effect<void, NodeStoreUnusable | ProfileNotCopied>;
  /**
   * Puts a suspended session: what its browser wrote, above the layer that is named, and
   * its files. One that is there already is left as it is, and one that was cut short is
   * put again from the start.
   */
  readonly putSession: (
    session: NodeSession,
  ) => Effect.Effect<void, NodeStoreUnusable | ProfileNotCopied>;
}

export class NodeStore extends Context.Service<NodeStore, NodeStoreShape>()(
  "@aperture-browser/migrate/NodeStore",
) {}
