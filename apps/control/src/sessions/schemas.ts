import type * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

/** What whoever owns the session asked it to be. */
export const DesiredState = Schema.Literals(["running", "suspended"]);
export type DesiredState = typeof DesiredState.Type;

/**
 * What the session's node last said it is. `gone` is a session its node has no more
 * though nobody asked the control plane to delete it.
 */
export const ObservedState = Schema.Literals([
  "suspended",
  "starting",
  "running",
  "suspending",
  "failed",
  "gone",
]);
export type ObservedState = typeof ObservedState.Type;

export const Session = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  /** The node it is on; none for a session that is gone from its node. */
  nodeId: Schema.NullOr(Schema.String),
  desiredState: DesiredState,
  observedState: ObservedState,
  failure: Schema.NullOr(Schema.String),
  /** Since when its node is silent or does not answer; what was observed is from before. */
  unreachableSince: Schema.NullOr(Schema.DateTimeUtcFromDate),
  snapshotId: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtcFromDate,
  observedAt: Schema.DateTimeUtcFromDate,
});
export type Session = typeof Session.Type;

/** What a node says of a session of its own. */
export interface Observation {
  readonly id: string;
  readonly state: ObservedState;
  readonly failure: string | null;
}

/** A ticket into a session, and where its holder goes with it. */
export interface Admission {
  readonly ticket: string;
  readonly expiresAt: DateTime.Utc;
  /** The session's workbench with the ticket in it; none where its node has no public address. */
  readonly url: string | null;
}
