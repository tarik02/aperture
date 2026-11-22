import * as Schema from "effect/Schema";

/** A snapshot as the control plane knows it: whose it is, and where it is found. */
export const Snapshot = Schema.Struct({
  id: Schema.String,
  /**
   * The account that made it. Of no workspace, the snapshot is that account's own; of one,
   * it is the workspace's, and this is none where nobody is known to have made it or the
   * account was removed since.
   */
  accountId: Schema.NullOr(Schema.String),
  /** The workspace it is of: the one its session was of when it was taken. */
  workspaceId: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  tags: Schema.Record(Schema.String, Schema.String),
  /** The session it was taken of, which may be gone since. */
  sessionId: Schema.NullOr(Schema.String),
  /** The node it was taken on; none once that node is forgotten. */
  nodeId: Schema.NullOr(Schema.String),
  /** Whether it is kept where other nodes find it; that node's alone otherwise. */
  shared: Schema.Boolean,
  createdAt: Schema.DateTimeUtcFromDate,
});
export type Snapshot = typeof Snapshot.Type;
