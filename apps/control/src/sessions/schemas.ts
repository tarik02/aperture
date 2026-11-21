import { DesiredState, ObservedState } from "@aperture-browser/control-api";
import type * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

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
  /** What its owner calls it. */
  label: Schema.NullOr(Schema.String),
  tags: Schema.Record(Schema.String, Schema.String),
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
