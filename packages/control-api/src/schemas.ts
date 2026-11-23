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
 * What a share link lets a guest do in its session: watch it, or control it as well, which
 * is giving input, opening and closing tabs, taking a tab, the clipboard and the sound.
 */
export const ShareRole = Schema.Literals(["watch", "control"]);
export type ShareRole = typeof ShareRole.Type;

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

/**
 * What an API token is held to: it does what its scopes name and nothing else. Writing
 * something includes reading it. `sessions:read` sees sessions and watches them, and
 * `sessions:write` does everything else in one; `workspaces:read` tells which workspaces
 * its account is in and who else is; `events:read` reads the events of its account and of
 * the workspaces that is in, and `admin` is what an admin's token keeps an admin's with.
 */
export const Scope = Schema.Literals([
  "sessions:read",
  "sessions:write",
  "snapshots:read",
  "snapshots:write",
  "workspaces:read",
  "workspaces:write",
  "tokens:write",
  "events:read",
  "admin",
]);
export type Scope = typeof Scope.Type;

/** Whether scopes cover one that is asked for; no scopes at all cover everything. */
export const covers = (held: ReadonlyArray<Scope> | null, asked: Scope) =>
  held === null ||
  held.includes(asked) ||
  (asked.endsWith(":read") && held.includes(asked.replace(":read", ":write") as Scope));

/**
 * What an API token is held to besides its scopes: with resources it reaches only the
 * sessions and snapshots that are named, and those of the workspaces that are named.
 */
export const TokenResources = Schema.Struct({
  workspaces: Schema.Array(Schema.String),
  sessions: Schema.Array(Schema.String),
  snapshots: Schema.Array(Schema.String),
});
export type TokenResources = typeof TokenResources.Type;

/**
 * What an event says was done. The set is closed: what reads events knows every kind
 * there is, and a new one is added here.
 */
export const EventKind = Schema.Literals([
  "sign_in.succeeded",
  "sign_in.failed",
  "account.created",
  "account.changed",
  "account.disabled",
  "account.enabled",
  "account.removed",
  "account.setup_link_made",
  "account.second_factor_reset",
  "account.passkeys_removed",
  "token.created",
  "token.revoked",
  "grant.given",
  "grant.revoked",
  "registration_token.created",
  "registration_token.revoked",
  "workspace.created",
  "workspace.renamed",
  "workspace.deleted",
  "workspace.member_admitted",
  "workspace.member_dismissed",
  "session.created",
  "session.suspended",
  "session.resumed",
  "session.deleted",
  "snapshot.taken",
  "snapshot.replaced",
  "snapshot.deleted",
  "share.created",
  "share.revoked",
  "share.joined",
  "node.registered",
  "node.refused",
  "node.released",
  "node.silent",
  "provider.added",
  "provider.changed",
  "provider.enabled",
  "provider.disabled",
  "provider.removed",
]);
export type EventKind = typeof EventKind.Type;

/**
 * Who did what an event says: an account, the guest of a share link, the holder of the
 * bootstrap token, someone who is not known, as whoever failed to sign in, or the control
 * plane by itself.
 */
export const EventActor = Schema.Struct({
  kind: Schema.Literals(["account", "guest", "bootstrap", "anonymous", "system"]),
  /** An account's id, or `share:<id>` for a guest; none for the others. */
  id: Schema.NullOr(Schema.String),
  /** What they were called then. */
  name: Schema.NullOr(Schema.String),
});
export type EventActor = typeof EventActor.Type;

/** What an event is about, as it was called then: it may be gone, or called otherwise, since. */
export const EventResource = Schema.Struct({
  kind: Schema.Literals([
    "account",
    "token",
    "grant",
    "registration_token",
    "workspace",
    "session",
    "snapshot",
    "share",
    "node",
    "provider",
  ]),
  id: Schema.String,
  label: Schema.NullOr(Schema.String),
});
export type EventResource = typeof EventResource.Type;

/** What else an event of its kind says, in a few plain values. Never a secret. */
export const EventDetail = Schema.Record(
  Schema.String,
  Schema.Union([
    Schema.String,
    Schema.Number,
    Schema.Boolean,
    Schema.Null,
    Schema.Array(Schema.String),
  ]),
);
export type EventDetail = typeof EventDetail.Type;
