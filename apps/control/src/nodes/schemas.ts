import { Offers } from "@aperture-browser/control-api";
import * as Schema from "effect/Schema";

/** A node as it is kept: its operator token sealed. */
export const NodeRecord = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  internalUrl: Schema.String,
  balancerUrl: Schema.NullOr(Schema.String),
  publicUrl: Schema.NullOr(Schema.String),
  operatorTokenSealed: Schema.String,
  /** None until the control plane has reached the node's executor. */
  offers: Schema.NullOr(Offers),
  /** The token it registered with; none for the one that is good without being made. */
  registrationTokenId: Schema.NullOr(Schema.String),
  registeredAt: Schema.DateTimeUtcFromDate,
  lastSeenAt: Schema.DateTimeUtcFromDate,
});
export type NodeRecord = typeof NodeRecord.Type;

/** A node the control plane can drive: with its operator token as the node gave it. */
export interface Node extends Omit<NodeRecord, "operatorTokenSealed"> {
  readonly operatorToken: string;
}

/** A registration token as it is kept: never the token. */
export const RegistrationToken = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  createdAt: Schema.DateTimeUtcFromDate,
  /** When it was taken back; it is kept so that an admin sees it was. */
  revokedAt: Schema.NullOr(Schema.DateTimeUtcFromDate),
});
export type RegistrationToken = typeof RegistrationToken.Type;

/** What a node says of itself in a keepalive. */
export interface Keepalive {
  readonly registrationToken: string;
  readonly name: string;
  readonly internalUrl: string;
  readonly balancerUrl?: string | undefined;
  readonly publicUrl?: string | undefined;
  readonly operatorToken: string;
}
