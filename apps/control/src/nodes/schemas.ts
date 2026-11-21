import * as Schema from "effect/Schema";

/** What a node's executor says its sessions may have, in the words of the glossary. */
export const Offers = Schema.Struct({
  version: Schema.String,
  features: Schema.Array(Schema.String),
  network: Schema.Struct({ tcp: Schema.String, udp: Schema.String }),
  /** The limits of a session that has none of its own; one that is left out is not held. */
  limits: Schema.Struct({
    memoryBytes: Schema.optional(Schema.Number),
    swapBytes: Schema.optional(Schema.Number),
    cpus: Schema.optional(Schema.Number),
    tasks: Schema.optional(Schema.Number),
    suspendIdleAfterSeconds: Schema.optional(Schema.Number),
  }),
  holdsResources: Schema.Boolean,
});
export type Offers = typeof Offers.Type;

export const Node = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  internalUrl: Schema.String,
  balancerUrl: Schema.NullOr(Schema.String),
  publicUrl: Schema.NullOr(Schema.String),
  operatorToken: Schema.String,
  /** None until the control plane has reached the node's executor. */
  offers: Schema.NullOr(Offers),
  registeredAt: Schema.DateTimeUtcFromDate,
  lastSeenAt: Schema.DateTimeUtcFromDate,
});
export type Node = typeof Node.Type;

/** A registration token as it is kept: never the token. */
export const RegistrationToken = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  createdAt: Schema.DateTimeUtcFromDate,
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
