import * as Schema from "effect/Schema";

/**
 * Where a setting is said, from the widest to the narrowest: the whole deployment, a
 * workspace, a person (an account) wherever they are, a person as a member of one
 * workspace, and one session. What the nearest of them says is what a session has. An
 * admin says a person's bounds; the person says its values inside them.
 */
export const SettingLevel = Schema.Literals([
  "instance",
  "workspace",
  "account",
  "member",
  "session",
]);
export type SettingLevel = typeof SettingLevel.Type;

/** The levels, the widest first: what each says is what the ones after it start from. */
export const LEVELS: ReadonlyArray<SettingLevel> = [
  "instance",
  "workspace",
  "account",
  "member",
  "session",
];

/**
 * The levels a person says values of for themselves, as an admin says them of them too. A
 * quota's value an admin says there is also its most: the person says less, and no more.
 */
export const PERSONAL: ReadonlyArray<SettingLevel> = ["account", "member", "session"];

/**
 * Where what a session has comes from: a level, the control plane's settings, what the
 * program has where nothing is said, or each node's own, for what a node holds sessions
 * to and nobody said. `owner` is a level of the person a session or a membership is of,
 * told so to whoever does not read that person's settings.
 */
export const SettingSource = Schema.Literals([
  "default",
  "configuration",
  "instance",
  "workspace",
  "account",
  "member",
  "session",
  "node",
  "owner",
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
  /**
   * Whether it deletes something once its time is up. Never, where no level says a value,
   * stays never under any bound: a bound alone deletes nothing.
   */
  readonly deletes?: true;
  /**
   * Whether it limits how much is used. Below the deployment, a level's value is at most
   * what the levels above make of it: no level gives more than it was given, and none of
   * them is no limit under a number. Of one each node has its own of, that is at most the
   * node's own, where neither the deployment nor the environment says otherwise.
   */
  readonly quota?: true;
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
    levels: ["instance", "workspace", "account", "member"],
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
    deletes: true,
  },
  /** How long after it was created a session is deleted, unless it is pinned. */
  maxSessionAge: {
    type: { kind: "duration" },
    none: true,
    levels: ALL,
    fallback: null,
    variable: "APERTURE_CONTROL_MAX_SESSION_AGE",
    deletes: true,
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
  /**
   * How many sessions of a workspace, or of an account's own, are pinned at most; said of
   * a person, how many of theirs there.
   */
  maxPinnedSessions: {
    type: { kind: "count" },
    none: true,
    levels: ["instance", "workspace", "account", "member"],
    fallback: null,
    variable: "APERTURE_CONTROL_MAX_PINNED_SESSIONS",
    quota: true,
  },
  /** How many sessions one user has in a workspace, or of their own, at most. */
  sessionsPerUser: {
    type: { kind: "count" },
    none: true,
    levels: ["instance", "workspace", "account", "member"],
    fallback: null,
    variable: "APERTURE_CONTROL_SESSIONS_PER_USER",
    quota: true,
  },
  /** How many sessions a workspace has at most. */
  sessionsPerWorkspace: {
    type: { kind: "count" },
    none: true,
    levels: ["instance", "workspace"],
    fallback: null,
    variable: "APERTURE_CONTROL_SESSIONS_PER_WORKSPACE",
  },
  /**
   * How many sessions of a workspace, or of a user's own, run at once at most; said of a
   * person, how many of theirs there.
   */
  runningSessions: {
    type: { kind: "count" },
    none: true,
    levels: ["instance", "workspace", "account", "member"],
    fallback: null,
    variable: "APERTURE_CONTROL_RUNNING_SESSIONS",
    quota: true,
  },
  /** The memory a session may use, in bytes; each node's own where nothing says it. */
  sessionMemory: {
    type: { kind: "bytes" },
    none: true,
    levels: LEVELS,
    fallback: undefined,
    variable: "APERTURE_CONTROL_SESSION_MEMORY",
    quota: true,
  },
  /** The processors' worth of time a session may use; each node's own where nothing says it. */
  sessionCpus: {
    type: { kind: "cpus" },
    none: true,
    levels: LEVELS,
    fallback: undefined,
    variable: "APERTURE_CONTROL_SESSION_CPUS",
    quota: true,
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
  /**
   * The largest file put into a session, in bytes. Its node refuses a larger one before it
   * takes a byte of it.
   */
  uploadMaxSize: {
    type: { kind: "bytes" },
    none: true,
    levels: LEVELS,
    fallback: 1024 ** 3,
    variable: "APERTURE_CONTROL_UPLOAD_MAX_SIZE",
    quota: true,
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
    deletes: true,
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
  /**
   * Whether each node holds a session to its own as well, where that is less: a limit a
   * node has of its own, which a level below the deployment said a value of and neither
   * the deployment nor the environment did.
   */
  perNode: Schema.Boolean,
});
export type SettingEffective = typeof SettingEffective.Type;

/** A setting as one level has it. */
export const SettingView = Schema.Struct({
  key: SettingKey,
  /** What this level says; none where it says nothing. */
  here: Schema.NullOr(SettingEntry),
  /** What it comes to here, where nothing below says otherwise. */
  effective: SettingEffective,
  /** What the levels above make of it: what it comes to here where this level says nothing. */
  inherited: SettingEffective,
  /** The bounds the levels above set, which this one may not cross. */
  above: SettingBounds,
  /** Whether the caller changes the value this level says of it. */
  changeable: Schema.Boolean,
  /**
   * Whether the caller also says the bounds this level holds itself and those below to.
   * For one who does not, `here` is the value alone, and the bounds of this level are
   * among those `above`, as they hold them as those of the levels above do.
   */
  bounds: Schema.Boolean,
});
export type SettingView = typeof SettingView.Type;

export const SettingViews = Schema.Struct({ settings: Schema.Array(SettingView) });

/** Whether a setting is said at a level. */
export const saidAt = (key: SettingKey, level: SettingLevel) =>
  (SETTINGS[key].levels as ReadonlyArray<SettingLevel>).includes(level);

/** Whether a setting is a quota, whose values hold the levels below to at most them. */
export const isQuota = (key: SettingKey) => (SETTINGS[key] as SettingDefinition).quota === true;

/**
 * Whether a setting is a quota each node has its own of: below the deployment, nothing
 * says more than the node's own, nor no limit, where the deployment says nothing of it.
 */
export const isNodeQuota = (key: SettingKey) =>
  isQuota(key) && (SETTINGS[key] as SettingDefinition).fallback === undefined;
