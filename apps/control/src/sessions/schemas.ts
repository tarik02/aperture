import { DesiredState, ObservedState } from "@aperture-browser/control-api";
import type * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

export const Session = Schema.Struct({
  id: Schema.String,
  /**
   * The account that made it. Of no workspace, the session is that account's own; of one,
   * it is the workspace's, and this is none where nobody is known to have made it or the
   * account was removed since.
   */
  accountId: Schema.NullOr(Schema.String),
  /** The workspace it is of, whose members all have it. */
  workspaceId: Schema.NullOr(Schema.String),
  /** The node it is on; none for a session that is gone from its node. */
  nodeId: Schema.NullOr(Schema.String),
  desiredState: DesiredState,
  observedState: ObservedState,
  failure: Schema.NullOr(Schema.String),
  /** Since when its node is silent or does not answer; what was observed is from before. */
  unreachableSince: Schema.NullOr(Schema.DateTimeUtcFromDate),
  snapshotId: Schema.NullOr(Schema.String),
  /** What its owner calls it. */
  label: Schema.NullOr(Schema.String),
  tags: Schema.Record(Schema.String, Schema.String),
  createdAt: Schema.DateTimeUtcFromDate,
  observedAt: Schema.DateTimeUtcFromDate,
  /** Whether it is kept from being deleted by itself. */
  pinned: Schema.Boolean,
  /** Since when its node says it is suspended, while it says so. */
  suspendedSince: Schema.NullOr(Schema.DateTimeUtcFromDate),
  /** Suspended by its node for sitting idle, until someone reaches it. */
  asleep: Schema.Boolean,
});
export type Session = typeof Session.Type;

/** What a node says of a session of its own. */
export interface Observation {
  readonly id: string;
  readonly state: ObservedState;
  readonly failure: string | null;
  /** Suspended by its node for sitting idle, until someone reaches it. */
  readonly asleep: boolean;
}

/** A ticket into a session, and where its holder goes with it. */
export interface Admission {
  readonly ticket: string;
  readonly expiresAt: DateTime.Utc;
  /** The session's workbench with the ticket in it. */
  readonly url: string;
}

/** An address one file of a session is read at or put to, and until when. */
export interface FileLink {
  readonly url: string;
  readonly method: "GET" | "PUT";
  readonly expiresAt: DateTime.Utc;
}
