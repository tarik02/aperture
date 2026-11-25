import * as Schema from "effect/Schema";

/**
 * Where a setting is said, from the widest to the narrowest: the whole deployment, a
 * workspace, an account, which a person sets for themselves, and one session. What the
 * nearest of them says is what a session has.
 */
export const SettingLevel = Schema.Literals(["instance", "workspace", "account", "session"]);
export type SettingLevel = typeof SettingLevel.Type;

/** The levels, the widest first: what each says is what the ones after it start from. */
export const LEVELS: ReadonlyArray<SettingLevel> = ["instance", "workspace", "account", "session"];

/**
 * Where what a session has comes from: a level, the control plane's settings, what the
 * program has where nothing is said, or each node's own, for what a node holds sessions
 * to and nobody said.
 */
export const SettingSource = Schema.Literals([
  "default",
  "configuration",
  "instance",
  "workspace",
  "account",
  "session",
  "node",
]);
export type SettingSource = typeof SettingSource.Type;

/**
 * What a setting is: a stretch of time in seconds, a count, bytes, processors' worth of
 * time, which may be a part of one, or one of a few choices. One
 * that may be none is never, or no limit, as `null`.
 */
export type SettingKind =
  | { readonly kind: "duration" }
  | { readonly kind: "count" }
  | { readonly kind: "bytes" }
  | { readonly kind: "cpus" }
  | { readonly kind: "choice"; readonly choices: ReadonlyArray<string | boolean> };

export interface SettingDefinition {
  readonly type: SettingKind;
  /** Whether it may be none: never, for a time; no limit, for a count. */
  readonly none: boolean;
  /** The levels it is said at. */
  readonly levels: ReadonlyArray<SettingLevel>;
  /**
   * What it is where nothing says otherwise; nothing for one each node has a value of
   * its own of.
   */
  readonly fallback: SettingValue | undefined;
  /** The variable of the control plane's environment that says it for the deployment. */
  readonly variable: string;
}

const ALL = LEVELS;

/** Every setting there is, and what it is. */
export const SETTINGS = {
  /** How long nobody may use a session before its node suspends it. */
  suspendIdleAfter: {
    type: { kind: "duration" },
    none: true,
    levels: ALL,
    fallback: undefined,
    variable: "APERTURE_CONTROL_SUSPEND_IDLE_AFTER",
  },
  /** Whether a pinned session is kept from being suspended for sitting idle. */
  pinnedStayAwake: {
    type: { kind: "choice", choices: [true, false] },
    none: false,
    levels: ["instance", "workspace", "account"],
    fallback: false,
    variable: "APERTURE_CONTROL_PINNED_STAY_AWAKE",
  },
  /** How long a session may stay suspended before it is deleted, unless it is pinned. */
  deleteSuspendedAfter: {
    type: { kind: "duration" },
    none: true,
    levels: ALL,
    fallback: null,
    variable: "APERTURE_CONTROL_DELETE_SUSPENDED_AFTER",
  },
  /** How long after it was created a session is deleted, unless it is pinned. */
  maxSessionAge: {
    type: { kind: "duration" },
    none: true,
    levels: ALL,
    fallback: null,
    variable: "APERTURE_CONTROL_MAX_SESSION_AGE",
  },
  /** How long what was deleted is kept in the database before it is removed for good. */
  purgeDeletedAfter: {
    type: { kind: "duration" },
    none: true,
    levels: ["instance"],
    fallback: null,
    variable: "APERTURE_CONTROL_PURGE_DELETED_AFTER",
  },
  /**
   * Who pins a session: anyone who acts on it, the admins of its workspace (the owner, of
   * a session of no workspace), or nobody.
   */
  pinning: {
    type: { kind: "choice", choices: ["anyone", "admins", "nobody"] },
    none: false,
    levels: ["instance", "workspace"],
    fallback: "admins",
    variable: "APERTURE_CONTROL_PINNING",
  },
  /** How many sessions of a workspace, or of an account's own, are pinned at most. */
  maxPinnedSessions: {
    type: { kind: "count" },
    none: true,
    levels: ["instance", "workspace"],
    fallback: null,
    variable: "APERTURE_CONTROL_MAX_PINNED_SESSIONS",
  },
  /** How many sessions one user has in a workspace, or of their own, at most. */
  sessionsPerUser: {
    type: { kind: "count" },
    none: true,
    levels: ["instance", "workspace"],
    fallback: null,
    variable: "APERTURE_CONTROL_SESSIONS_PER_USER",
  },
  /** How many sessions a workspace has at most. */
  sessionsPerWorkspace: {
    type: { kind: "count" },
    none: true,
    levels: ["instance", "workspace"],
    fallback: null,
    variable: "APERTURE_CONTROL_SESSIONS_PER_WORKSPACE",
  },
  /** How many sessions of a workspace, or of a user's own, run at once at most. */
  runningSessions: {
    type: { kind: "count" },
    none: true,
    levels: ["instance", "workspace"],
    fallback: null,
    variable: "APERTURE_CONTROL_RUNNING_SESSIONS",
  },
  /** The memory a session may use, in bytes; each node's own where nothing says it. */
  sessionMemory: {
    type: { kind: "bytes" },
    none: true,
    levels: LEVELS,
    fallback: undefined,
    variable: "APERTURE_CONTROL_SESSION_MEMORY",
  },
  /** The processors' worth of time a session may use; each node's own where nothing says it. */
  sessionCpus: {
    type: { kind: "cpus" },
    none: true,
    levels: LEVELS,
    fallback: undefined,
    variable: "APERTURE_CONTROL_SESSION_CPUS",
  },
  /**
   * What is copied passes between a session and its clients both ways (`rw`), only out of
   * the session to them (`ro`), or not at all (`off`).
   */
  clipboard: {
    type: { kind: "choice", choices: ["rw", "ro", "off"] },
    none: false,
    levels: LEVELS,
    fallback: "rw",
    variable: "APERTURE_CONTROL_CLIPBOARD",
  },
  /** Whether files are put into a session. */
  uploads: {
    type: { kind: "choice", choices: [true, false] },
    none: false,
    levels: LEVELS,
    fallback: true,
    variable: "APERTURE_CONTROL_UPLOADS",
  },
  /** Whether a session's browser downloads files, and they are taken out of it. */
  downloads: {
    type: { kind: "choice", choices: [true, false] },
    none: false,
    levels: LEVELS,
    fallback: true,
    variable: "APERTURE_CONTROL_DOWNLOADS",
  },
  /** Whether a session's tabs are recorded and screenshots kept. */
  recording: {
    type: { kind: "choice", choices: [true, false] },
    none: false,
    levels: LEVELS,
    fallback: true,
    variable: "APERTURE_CONTROL_RECORDING",
  },
  /** How long a session's recordings and screenshots are kept before its node removes them. */
  recordingRetention: {
    type: { kind: "duration" },
    none: true,
    levels: LEVELS,
    fallback: null,
    variable: "APERTURE_CONTROL_RECORDING_RETENTION",
  },
  /** How long a share link is good for at most; one that never runs out is refused. */
  shareLinkMaxLifetime: {
    type: { kind: "duration" },
    none: true,
    levels: LEVELS,
    fallback: null,
    variable: "APERTURE_CONTROL_SHARE_LINK_MAX_LIFETIME",
  },
  /** How long an API token is good for at most; one that never runs out is refused. */
  apiTokenMaxLifetime: {
    type: { kind: "duration" },
    none: true,
    levels: ["instance", "account"],
    fallback: null,
    variable: "APERTURE_CONTROL_API_TOKEN_MAX_LIFETIME",
  },
} as const satisfies Record<string, SettingDefinition>;

export type SettingKey = keyof typeof SETTINGS;
export const SettingKey = Schema.Literals(
  Object.keys(SETTINGS) as [SettingKey, ...Array<SettingKey>],
);

/** A setting's value: seconds or a count, a choice, or none for never and no limit. */
export const SettingValue = Schema.Union([
  Schema.Number,
  Schema.String,
  Schema.Boolean,
  Schema.Null,
]);
export type SettingValue = typeof SettingValue.Type;

/**
 * What one level says of a setting: its value, which the levels below it may say otherwise,
 * and bounds they may not cross: `min` and `max` for a time or a count, `allowed` for a
 * choice. A bound of both ends alike is a lock.
 */
export const SettingEntry = Schema.Struct({
  /** Left out, this level says no value; `null` is never, or no limit. */
  value: Schema.optional(SettingValue),
  min: Schema.optional(Schema.Number),
  max: Schema.optional(Schema.Number),
  allowed: Schema.optional(Schema.Array(SettingValue)),
});
export type SettingEntry = typeof SettingEntry.Type;

/** A bound, and the level that sets it. */
export const SettingBound = Schema.Struct({ value: Schema.Number, level: SettingLevel });
export type SettingBound = typeof SettingBound.Type;

export const SettingAllowed = Schema.Struct({
  values: Schema.Array(SettingValue),
  level: SettingLevel,
});
export type SettingAllowed = typeof SettingAllowed.Type;

/** The bounds that hold where they apply, each the narrowest of those set, with its level. */
export const SettingBounds = Schema.Struct({
  min: Schema.NullOr(SettingBound),
  max: Schema.NullOr(SettingBound),
  allowed: Schema.NullOr(SettingAllowed),
});
export type SettingBounds = typeof SettingBounds.Type;

/** What a setting comes to, and why. */
export const SettingEffective = Schema.Struct({
  /** What it is; none of `node`'s, which each node says. */
  value: SettingValue,
  source: SettingSource,
  /** Whether a level above leaves this one no other value. */
  locked: Schema.Boolean,
  /** Whether a nearer value crossed a bound, and the bound's value was taken in its place. */
  clamped: Schema.Boolean,
});
export type SettingEffective = typeof SettingEffective.Type;

/** A setting as one level has it. */
export const SettingView = Schema.Struct({
  key: SettingKey,
  /** What this level says; none where it says nothing. */
  here: Schema.NullOr(SettingEntry),
  /** What it comes to here, where nothing below says otherwise. */
  effective: SettingEffective,
  /** The bounds the levels above set, which this one may not cross. */
  above: SettingBounds,
  /** Whether the caller changes what this level says of it. */
  changeable: Schema.Boolean,
});
export type SettingView = typeof SettingView.Type;

export const SettingViews = Schema.Struct({ settings: Schema.Array(SettingView) });

/** Whether a setting is said at a level. */
export const saidAt = (key: SettingKey, level: SettingLevel) =>
  (SETTINGS[key].levels as ReadonlyArray<SettingLevel>).includes(level);
