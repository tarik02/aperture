import {
  LEVELS,
  SETTINGS,
  type SettingEffective,
  type SettingEntry,
  type SettingKey,
  type SettingLevel,
  type SettingValue,
  type SettingView,
  PERSONAL,
  isNodeQuota,
  isQuota,
  saidAt,
} from "@aperture-browser/control-api";
import {
  byWhom,
  factorOf,
  inUnits,
  unitsOf,
  valueWords,
} from "#/features/settings/setting-words.ts";

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

/** A number as it is typed, without the noise adding parts of one leaves in it. */
export const tidy = (value: number) => String(Number(value.toFixed(4)));

export const amountOf = (key: SettingKey, value: number | undefined, unit?: string): Amount => {
  const units = unitsOf(key);
  if (value === undefined) {
    return { amount: "", unit: unit ?? units[0]?.value ?? "" };
  }
  if (unit !== undefined && units.length > 0) {
    return { amount: tidy(value / factorOf(unit, units)), unit };
  }
  const shown = inUnits(value, units);
  return { amount: tidy(shown.amount), unit: shown.unit };
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
 * What a level says, without a quota's most that is its value: what an admin says of a
 * quota at a person's levels is their most as well, whether or not it is said, and the
 * control plane keeps it so; a lock of it is said as one.
 */
const plain = (
  key: SettingKey,
  level: SettingLevel,
  entry: SettingEntry | null,
): SettingEntry | null => {
  if (
    entry === null ||
    !isQuota(key) ||
    !PERSONAL.includes(level) ||
    entry.max !== entry.value ||
    entry.min === entry.value
  ) {
    return entry;
  }
  const { max: _, ...rest } = entry;
  return rest;
};

/** What a level says of a setting, as it is edited. */
export const draftOf = (setting: SettingView, level: SettingLevel): Draft => {
  const { key } = setting;
  const here = plain(key, level, setting.here);
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
  return SETTINGS[key].type.kind === "cpus" ? Number(scaled.toFixed(3)) : Math.round(scaled);
};

/** The least a value of a setting is: none for a count, more than none for the rest. */
const valueProblem = (key: SettingKey, amount: Amount) => {
  if (!filled(amount)) {
    return "Enter an amount.";
  }
  const typed = Number(amount.amount);
  if (!Number.isFinite(typed)) {
    return "Enter a number.";
  }
  const { kind } = SETTINGS[key].type;
  if (kind === "count") {
    return Number.isInteger(typed) && typed >= 0 ? undefined : "Enter a whole number, 0 or more.";
  }
  if (!(typed > 0)) {
    return "Enter more than 0.";
  }
  return numberOf(key, amount) > 0
    ? undefined
    : kind === "duration"
      ? "Enter at least a second."
      : "Enter more than that.";
};

const boundProblem = (key: SettingKey, amount: Amount) => {
  const typed = Number(amount.amount);
  if (!Number.isFinite(typed) || typed < 0) {
    return "A limit is a number, 0 or more.";
  }
  return SETTINGS[key].type.kind === "count" && !Number.isInteger(typed)
    ? "A limit of a count is a whole number."
    : undefined;
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
    if (limited && draft.allowed.length === 0) {
      return { problem: "Allow at least one choice below, or stop limiting them." };
    }
    return {
      entry: {
        ...(said ? { value } : {}),
        ...(bounds && draft.mode === "enforce" ? { allowed: [value] } : {}),
        ...(limited ? { allowed: draft.allowed.map(choice) } : {}),
      },
    };
  }
  const entry: { value?: SettingValue; min?: number; max?: number } = {};
  if (draft.mode === "none") {
    entry.value = null;
  } else if (draft.mode === "set" || draft.mode === "enforce") {
    const problem = valueProblem(key, draft.value);
    if (problem !== undefined) {
      return { problem };
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
        const problem = boundProblem(key, draft[end]);
        if (problem !== undefined) {
          return { problem };
        }
        entry[end] = numberOf(key, draft[end]);
      }
    }
    if (entry.min !== undefined && entry.max !== undefined && entry.min > entry.max) {
      return { problem: "The least below is more than the most below." };
    }
    if (typeof entry.value === "number" || entry.value === null) {
      const value = entry.value ?? Number.POSITIVE_INFINITY;
      if (
        (entry.min !== undefined && value < entry.min) ||
        (entry.max !== undefined && value > entry.max)
      ) {
        return { problem: "The value is outside the limits it sets below." };
      }
    }
  }
  return { entry };
};

/**
 * Whether no limit is refused for a node's own: each node holds a level below the
 * deployment to its own, where nothing above says a number.
 */
export const noneOverNode = (setting: SettingView, level: SettingLevel) =>
  isNodeQuota(setting.key) && level !== "instance" && setting.inherited.source === "node";

/**
 * What of an entry the levels above do not let it be, as it is said on its row: said before
 * it is saved, as the control plane would refuse it.
 */
export const beyondOf = (
  setting: SettingView,
  entry: SettingEntry,
  level: SettingLevel,
): string | undefined => {
  const { key, above } = setting;
  const most = (bound: NonNullable<typeof above.max>) =>
    `${byWhom(setting, bound.level, level, true)} holds it to at most ${valueWords(key, bound.value)}.`;
  const least = (bound: NonNullable<typeof above.min>) =>
    `${byWhom(setting, bound.level, level, true)} holds it to at least ${valueWords(key, bound.value)}.`;
  const { value, min, max, allowed } = entry;
  if (isChoice(key)) {
    const only = above.allowed;
    const beyond = [...(value === undefined ? [] : [value]), ...(allowed ?? [])].some(
      (one) => only !== null && !only.values.includes(one),
    );
    return beyond && only !== null
      ? `${byWhom(setting, only.level, level, true)} allows only ${only.values.map((one) => valueWords(key, one)).join(", ")}.`
      : undefined;
  }
  if (value === null && noneOverNode(setting, level)) {
    return "Each node holds it to its own: no limit is for the instance to say.";
  }
  const ranked = value === undefined ? undefined : value === null ? Infinity : Number(value);
  for (const said of [ranked, max, min]) {
    if (said === undefined) {
      continue;
    }
    if (above.max !== null && said > above.max.value) {
      return most(above.max);
    }
    if (above.min !== null && said < above.min.value) {
      return least(above.min);
    }
  }
  return undefined;
};

const canonical = (key: SettingKey, level: SettingLevel, said: SettingEntry) => {
  const entry = plain(key, level, said) ?? {};
  return JSON.stringify({
    value: entry.value,
    min: entry.min,
    max: entry.max,
    allowed: entry.allowed === undefined ? undefined : entry.allowed.map(String).toSorted(),
  });
};

/** Whether a draft says other than what the level says now. */
export const changes = (
  setting: SettingView,
  draft: Draft,
  bounds: boolean,
  level: SettingLevel,
) => {
  const made = entryOf(setting.key, draft, bounds);
  return (
    "problem" in made ||
    canonical(setting.key, level, made.entry) !== canonical(setting.key, level, setting.here ?? {})
  );
};
