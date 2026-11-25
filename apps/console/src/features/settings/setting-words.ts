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
};

const CHOICE_WORDS: Readonly<Record<string, string>> = {
  true: "Yes",
  false: "No",
  anyone: "Anyone",
  admins: "Admins",
  nobody: "Nobody",
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

/** The units a time is said in, the largest first. */
export const UNITS = [
  { value: "days", label: "days", seconds: 86_400 },
  { value: "hours", label: "hours", seconds: 3600 },
  { value: "minutes", label: "minutes", seconds: 60 },
] as const;
export type Unit = (typeof UNITS)[number]["value"];

/** A number of seconds in the largest unit it is a whole number of. */
export const inUnits = (seconds: number): { amount: number; unit: Unit } => {
  const unit = UNITS.find((one) => seconds % one.seconds === 0) ?? UNITS[UNITS.length - 1];
  return unit === undefined
    ? { amount: seconds, unit: "minutes" }
    : { amount: seconds / unit.seconds, unit: unit.value };
};

export const secondsOf = (amount: number, unit: Unit) =>
  amount * (UNITS.find((one) => one.value === unit)?.seconds ?? 1);

const time = (seconds: number) => {
  const { amount, unit } = inUnits(seconds);
  const word = amount === 1 ? unit.slice(0, -1) : unit;
  return seconds % 60 === 0 ? `${amount} ${word}` : `${seconds} seconds`;
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
      return String(value);
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
