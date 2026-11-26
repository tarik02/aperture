import {
  LEVELS,
  SETTINGS,
  type SettingEffective,
  type SettingEntry,
  type SettingKey,
  type SettingLevel,
  type SettingValue,
  type SettingView,
  isQuota,
  saidAt,
} from "@aperture-browser/control-api";
import { factorOf, inUnits, unitsOf } from "#/features/settings/setting-words.ts";

/**
 * How a level has a setting: as the levels above have it, a value of its own, none (never,
 * no limit), or a value of its own that the levels below have to keep.
 */
export type Mode = "inherit" | "set" | "none" | "enforce";

/** A number as it is typed, and the unit it is typed in; no unit for a count. */
export type Amount = { readonly amount: string; readonly unit: string };

/** What is being said of one setting, before it is saved. */
export type Draft = {
  readonly mode: Mode;
  readonly value: Amount;
  readonly choice: string;
  /** Whether the levels below are held to bounds, which an enforced value is of itself. */
  readonly limited: boolean;
  readonly min: Amount;
  readonly max: Amount;
  readonly allowed: ReadonlyArray<string>;
};

export const isChoice = (key: SettingKey) => SETTINGS[key].type.kind === "choice";

export const choicesOf = (key: SettingKey): ReadonlyArray<string | boolean> => {
  const { type } = SETTINGS[key];
  return type.kind === "choice" ? type.choices : [];
};

/** Whether a level below this one says the setting, and so has bounds to keep. */
export const boundsBelow = (key: SettingKey, level: SettingLevel) =>
  LEVELS.slice(LEVELS.indexOf(level) + 1).some((below) => saidAt(key, below));

/** What the level would have if it said no value: what it has now, where it says none. */
export const inheritedOf = (setting: SettingView): SettingEffective =>
  setting.here?.value === undefined ? setting.effective : setting.inherited;

export const amountOf = (key: SettingKey, value: number | undefined, unit?: string): Amount => {
  const units = unitsOf(key);
  if (value === undefined) {
    return { amount: "", unit: unit ?? units[0]?.value ?? "" };
  }
  const shown = inUnits(value, units);
  return { amount: String(shown.amount), unit: shown.unit };
};

const enforcedOf = (key: SettingKey, entry: SettingEntry | null) => {
  const value = entry?.value;
  if (entry === null || value === undefined || value === null) {
    return false;
  }
  return isChoice(key)
    ? entry.allowed?.length === 1 && entry.allowed[0] === value
    : entry.min === value && entry.max === value;
};

/**
 * What a level says, without a quota's most that is its value: a quota's value holds the
 * levels below to it, and a person's at most to it as well, whether or not it is said.
 */
const plain = (key: SettingKey, entry: SettingEntry | null): SettingEntry | null => {
  if (entry === null || !isQuota(key) || entry.min !== undefined || entry.max !== entry.value) {
    return entry;
  }
  const { max: _, ...rest } = entry;
  return rest;
};

/** What a level says of a setting, as it is edited. */
export const draftOf = (setting: SettingView): Draft => {
  const { key } = setting;
  const here = plain(key, setting.here);
  const said = here?.value;
  const inherited = inheritedOf(setting).value;
  const enforced = enforcedOf(key, here);
  const value = amountOf(
    key,
    typeof said === "number" ? said : typeof inherited === "number" ? inherited : undefined,
  );
  return {
    mode: said === undefined ? "inherit" : said === null ? "none" : enforced ? "enforce" : "set",
    value,
    choice: String(said ?? (inherited === null ? undefined : inherited) ?? choicesOf(key)[0] ?? ""),
    limited:
      !enforced &&
      (here?.min !== undefined || here?.max !== undefined || here?.allowed !== undefined),
    min: enforced ? amountOf(key, undefined, value.unit) : amountOf(key, here?.min, value.unit),
    max: enforced ? amountOf(key, undefined, value.unit) : amountOf(key, here?.max, value.unit),
    allowed: enforced ? [] : (here?.allowed ?? []).map(String),
  };
};

const filled = (amount: Amount) => amount.amount.trim() !== "";

const numberOf = (key: SettingKey, amount: Amount) => {
  const scaled = Number(amount.amount) * factorOf(amount.unit, unitsOf(key));
  return SETTINGS[key].type.kind === "cpus" ? scaled : Math.round(scaled);
};

/** What a draft says to the control plane; or what is wrong with it, said on its row. */
export const entryOf = (
  key: SettingKey,
  draft: Draft,
  bounds: boolean,
): { readonly entry: SettingEntry } | { readonly problem: string } => {
  const limited = bounds && draft.limited && draft.mode !== "enforce";
  if (isChoice(key)) {
    const choice = (text: string): SettingValue =>
      choicesOf(key).find((one) => String(one) === text) ?? text;
    const said = draft.mode === "set" || draft.mode === "enforce";
    const value = choice(draft.choice);
    return {
      entry: {
        ...(said ? { value } : {}),
        ...(bounds && draft.mode === "enforce" ? { allowed: [value] } : {}),
        ...(limited && draft.allowed.length > 0 ? { allowed: draft.allowed.map(choice) } : {}),
      },
    };
  }
  const entry: { value?: SettingValue; min?: number; max?: number } = {};
  if (draft.mode === "none") {
    entry.value = null;
  } else if (draft.mode === "set" || draft.mode === "enforce") {
    if (!(Number(draft.value.amount) > 0)) {
      return { problem: "Say how much." };
    }
    entry.value = numberOf(key, draft.value);
    if (bounds && draft.mode === "enforce") {
      entry.min = entry.value;
      entry.max = entry.value;
    }
  }
  if (limited) {
    for (const end of ["min", "max"] as const) {
      if (filled(draft[end])) {
        if (!(Number(draft[end].amount) >= 0)) {
          return { problem: "A bound is not below zero." };
        }
        entry[end] = numberOf(key, draft[end]);
      }
    }
    if (entry.min !== undefined && entry.max !== undefined && entry.min > entry.max) {
      return { problem: "The least is more than the most." };
    }
  }
  return { entry };
};

const canonical = (key: SettingKey, said: SettingEntry) => {
  const entry = plain(key, said) ?? {};
  return JSON.stringify({
    value: entry.value,
    min: entry.min,
    max: entry.max,
    allowed: entry.allowed === undefined ? undefined : entry.allowed.map(String).toSorted(),
  });
};

/** Whether a draft says other than what the level says now. */
export const changes = (setting: SettingView, draft: Draft, bounds: boolean) => {
  const made = entryOf(setting.key, draft, bounds);
  return (
    "problem" in made ||
    canonical(setting.key, made.entry) !== canonical(setting.key, setting.here ?? {})
  );
};
