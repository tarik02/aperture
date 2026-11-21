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
  /** Whether its snapshots are kept where other nodes find them. */
  sharesSnapshots: Schema.Boolean,
});
export type Offers = typeof Offers.Type;

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

/** The areas of a session a ticket gives access to, each read, written or both. */
export const Access = Schema.Record(
  Schema.Literals([
    "input",
    "tabs",
    "lease",
    "sound",
    "clipboard",
    "uploads",
    "downloads",
    "recordings",
    "proxy",
    "mcp",
    "cdp",
    "tunnel",
  ]),
  Schema.optional(Schema.Literals(["r", "w", "rw"])),
);
export type Access = typeof Access.Type;

/**
 * How a session's browser connections are routed. The first rule that matches a
 * connection decides; one no rule matches is made from the session's node.
 */
export const ProxyConfig = Schema.Struct({
  /** The upstreams rules can route through, by name. */
  upstreams: Schema.optional(
    Schema.Record(
      Schema.NonEmptyString,
      Schema.Struct({
        /** A proxy, with its credentials in the URL: `socks5://`, `http://`, `https://`. */
        url: Schema.NonEmptyString,
        /** The secret a tunnel is dialed with. */
        auth: Schema.optional(Schema.String),
      }),
    ),
  ),
  rules: Schema.Array(
    Schema.Struct({
      /** `host` or `host:port`; the host is exact, `*.suffix`, or `*` for any. */
      match: Schema.NonEmptyString,
      /** `direct`, `refuse`, `local`, an upstream's name, or a proxy's URL. */
      via: Schema.NonEmptyString,
      to: Schema.optional(Schema.String),
      tls: Schema.optional(Schema.Boolean),
    }),
  ),
});
export type ProxyConfig = typeof ProxyConfig.Type;
