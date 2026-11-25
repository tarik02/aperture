import {
  SETTINGS,
  type SettingEffective,
  type SettingKey,
  type SettingLevel,
  type SettingSource,
  type SettingValue,
} from "@aperture-browser/control-api";

/** What each setting is called, and in which group it is shown. */
export const SETTING_WORDS: Readonly<
  Record<SettingKey, { readonly label: string; readonly group: string; readonly none?: string }>
> = {
  suspendIdleAfter: { label: "Suspend when idle for", group: "Lifecycle", none: "Never" },
  pinnedStayAwake: { label: "Pinned sessions stay awake", group: "Lifecycle" },
  deleteSuspendedAfter: {
    label: "Delete when suspended for",
    group: "Lifecycle",
    none: "Never",
  },
  maxSessionAge: { label: "Delete when older than", group: "Lifecycle", none: "Never" },
  purgeDeletedAfter: { label: "Purge deleted records after", group: "Lifecycle", none: "Never" },
  pinning: { label: "Who pins sessions", group: "Pinning" },
  maxPinnedSessions: { label: "Pinned sessions at most", group: "Pinning", none: "No limit" },
  sessionsPerUser: { label: "Sessions per user", group: "Quotas", none: "No limit" },
  sessionsPerWorkspace: { label: "Sessions per workspace", group: "Quotas", none: "No limit" },
  runningSessions: { label: "Sessions running at once", group: "Quotas", none: "No limit" },
  sessionMemory: { label: "Memory per session", group: "Quotas", none: "No limit" },
  sessionCpus: { label: "Processors per session", group: "Quotas", none: "No limit" },
  clipboard: { label: "Clipboard", group: "Data" },
  uploads: { label: "Uploads allowed", group: "Data" },
  downloads: { label: "Downloads allowed", group: "Data" },
  recording: { label: "Recording allowed", group: "Data" },
  recordingRetention: { label: "Keep recordings for", group: "Data", none: "Ever" },
  shareLinkMaxLifetime: { label: "Share links last at most", group: "Data", none: "No limit" },
  apiTokenMaxLifetime: { label: "API tokens last at most", group: "Data", none: "No limit" },
};

const CHOICE_WORDS: Readonly<Record<string, string>> = {
  true: "Yes",
  false: "No",
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
  session: "session",
};

const SOURCE_WORDS: Readonly<Record<SettingSource, string>> = {
  ...LEVEL_WORDS,
  default: "default",
  configuration: "configuration",
  node: "node",
};

/** The units a time or a size is said in, the largest first; none for a count. */
const UNITS = {
  duration: [
    { value: "days", label: "days", factor: 86_400 },
    { value: "hours", label: "hours", factor: 3600 },
    { value: "minutes", label: "minutes", factor: 60 },
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

/** Where what a setting comes to comes from, and whether it is held there: `from workspace, locked`. */
export const sourceWords = (effective: SettingEffective) => {
  const from =
    effective.source === "node" ? "as each node has it" : `from ${SOURCE_WORDS[effective.source]}`;
  return [from, effective.locked ? "locked" : null, effective.clamped ? "bounded" : null]
    .filter((said) => said !== null)
    .join(", ");
};

/** What a setting comes to and where from, in one line: `1 hour · from workspace, locked`. */
export const effectiveWords = (key: SettingKey, effective: SettingEffective) =>
  effective.source === "node"
    ? "Each node's own"
    : `${valueWords(key, effective.value)} · ${sourceWords(effective)}`;
