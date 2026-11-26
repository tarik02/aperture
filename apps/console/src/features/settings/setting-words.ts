import {
  SETTINGS,
  type SettingKey,
  type SettingLevel,
  type SettingSource,
  type SettingValue,
} from "@aperture-browser/control-api";

/** What each setting is called, what it does in a line, and what its none is called. */
export const SETTING_WORDS: Readonly<
  Record<
    SettingKey,
    { readonly label: string; readonly description: string; readonly none?: string }
  >
> = {
  suspendIdleAfter: {
    label: "Suspend when idle",
    description: "A session nobody uses for this long is suspended.",
    none: "Never",
  },
  pinnedStayAwake: {
    label: "Pinned sessions stay awake",
    description: "A pinned session is not suspended for sitting idle.",
  },
  deleteSuspendedAfter: {
    label: "Delete when suspended",
    description: "A session suspended this long is deleted, unless it is pinned.",
    none: "Never",
  },
  maxSessionAge: {
    label: "Delete when older than",
    description: "A session this old is deleted, unless it is pinned.",
    none: "Never",
  },
  purgeDeletedAfter: {
    label: "Purge deleted records",
    description: "What was deleted is removed from the database for good after this.",
    none: "Never",
  },
  pinning: { label: "Who pins sessions", description: "Who may pin a session to keep it." },
  maxPinnedSessions: {
    label: "Pinned sessions",
    description: "How many sessions are pinned at most.",
    none: "No limit",
  },
  sessionsPerUser: {
    label: "Sessions per user",
    description: "How many sessions one user has at most.",
    none: "No limit",
  },
  sessionsPerWorkspace: {
    label: "Sessions per workspace",
    description: "How many sessions a workspace has at most.",
    none: "No limit",
  },
  runningSessions: {
    label: "Running sessions",
    description: "How many sessions run at once at most.",
    none: "No limit",
  },
  sessionMemory: {
    label: "Memory per session",
    description: "The memory one session may use.",
    none: "No limit",
  },
  sessionCpus: {
    label: "Processors per session",
    description: "The processors' worth of time one session may use.",
    none: "No limit",
  },
  clipboard: {
    label: "Clipboard",
    description: "Which way what is copied passes between a session and who uses it.",
  },
  uploads: { label: "Uploads", description: "Files may be put into a session." },
  downloads: {
    label: "Downloads",
    description: "A session's browser may download files, and they may be taken out.",
  },
  recording: {
    label: "Recording",
    description: "A session's tabs are recorded and screenshots of them kept.",
  },
  recordingRetention: {
    label: "Keep recordings",
    description: "Recordings and screenshots are removed after this.",
    none: "Forever",
  },
  shareLinkMaxLifetime: {
    label: "Share link lifetime",
    description: "How long a share link stays good at most.",
    none: "No limit",
  },
  apiTokenMaxLifetime: {
    label: "API token lifetime",
    description: "How long an API token stays good at most.",
    none: "No limit",
  },
};

/** The settings in the groups they are shown in, in the order they are shown. */
export const SETTING_GROUPS: ReadonlyArray<{
  readonly title: string;
  readonly keys: ReadonlyArray<SettingKey>;
}> = [
  {
    title: "Lifecycle",
    keys: ["suspendIdleAfter", "deleteSuspendedAfter", "maxSessionAge", "purgeDeletedAfter"],
  },
  { title: "Pinning", keys: ["pinning", "maxPinnedSessions", "pinnedStayAwake"] },
  {
    title: "Quotas",
    keys: [
      "sessionsPerUser",
      "sessionsPerWorkspace",
      "runningSessions",
      "sessionMemory",
      "sessionCpus",
    ],
  },
  {
    title: "Data",
    keys: ["clipboard", "uploads", "downloads", "recording", "recordingRetention"],
  },
  { title: "Access", keys: ["shareLinkMaxLifetime", "apiTokenMaxLifetime"] },
];

const CHOICE_WORDS: Readonly<Record<string, string>> = {
  true: "On",
  false: "Off",
  anyone: "Anyone",
  admins: "Admins",
  nobody: "Nobody",
  rw: "Both ways",
  ro: "Out of the session only",
  off: "Off",
};

/** A level as a person reads it. */
export const LEVEL_WORDS: Readonly<Record<SettingLevel, string>> = {
  instance: "instance",
  workspace: "workspace",
  account: "user",
  member: "membership",
  session: "session",
};

export const SOURCE_WORDS: Readonly<Record<SettingSource, string>> = {
  ...LEVEL_WORDS,
  default: "default",
  configuration: "configuration",
  node: "node",
  owner: "owner",
};

/** The units a time or a size is said in, the largest first; none for a count. */
const UNITS = {
  duration: [
    { value: "days", label: "d", factor: 86_400 },
    { value: "hours", label: "h", factor: 3600 },
    { value: "minutes", label: "min", factor: 60 },
  ],
  bytes: [
    { value: "GiB", label: "GiB", factor: 1024 ** 3 },
    { value: "MiB", label: "MiB", factor: 1024 ** 2 },
  ],
} as const;

export type Unit = { readonly value: string; readonly label: string; readonly factor: number };

export const unitsOf = (key: SettingKey): ReadonlyArray<Unit> => {
  const { kind } = SETTINGS[key].type;
  return kind === "duration" || kind === "bytes" ? UNITS[kind] : [];
};

/** A value in the largest of the units it is a whole number of; as it is, without units. */
export const inUnits = (value: number, units: ReadonlyArray<Unit>) => {
  const unit = units.find((one) => value % one.factor === 0) ?? units[units.length - 1];
  return unit === undefined
    ? { amount: value, unit: "" }
    : { amount: value / unit.factor, unit: unit.value };
};

export const factorOf = (unit: string, units: ReadonlyArray<Unit>) =>
  units.find((one) => one.value === unit)?.factor ?? 1;

const time = (seconds: number) => {
  const { amount, unit } = inUnits(seconds, UNITS.duration);
  const word = amount === 1 ? unit.slice(0, -1) : unit;
  return seconds % 60 === 0 ? `${amount} ${word}` : `${seconds} seconds`;
};

const size = (bytes: number) => {
  const unit = UNITS.bytes.find((one) => bytes >= one.factor);
  return unit === undefined
    ? `${bytes} bytes`
    : `${Number((bytes / unit.factor).toFixed(2))} ${unit.label}`;
};

/** A value of a setting, as it is shown. */
export const valueWords = (key: SettingKey, value: SettingValue) => {
  if (value === null) {
    return SETTING_WORDS[key].none ?? "None";
  }
  switch (SETTINGS[key].type.kind) {
    case "duration":
      return time(Number(value));
    case "count":
    case "cpus":
      return String(value);
    case "bytes":
      return size(Number(value));
    case "choice":
      return CHOICE_WORDS[String(value)] ?? String(value);
  }
};
