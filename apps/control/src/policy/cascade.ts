import {
  type SettingBound,
  type SettingBounds,
  type SettingDefinition,
  type SettingEffective,
  type SettingEntry,
  type SettingKey,
  type SettingLevel,
  type SettingValue,
  isQuota,
  LEVELS,
  SETTINGS,
  saidAt,
} from "@aperture-browser/control-api";
import * as Result from "effect/Result";
import { SettingInvalid, SettingOutOfBounds } from "../errors.ts";

/** What each level on the way to something says of one setting, the widest first. */
export type Chain = ReadonlyArray<{
  readonly level: SettingLevel;
  readonly entry: SettingEntry | undefined;
}>;

/**
 * What a setting is before any level says anything: what the environment says, or the
 * program's own; nothing for one that each node has a value of its own of.
 */
export interface Base {
  readonly value: SettingValue | undefined;
  readonly source: "configuration" | "default";
}

/** Where a value is among others of its setting: none, as never or no limit, after all. */
const rank = (value: SettingValue) => (value === null ? Number.POSITIVE_INFINITY : Number(value));

const numeric = (key: SettingKey) => SETTINGS[key].type.kind !== "choice";

/**
 * The narrowest of the bounds the levels set, each with the level that sets it. A level's
 * bound is held inside the range of those above it: one past it is that end of the range,
 * from the level above, so that nothing said below gets past a lock.
 */
export const boundsOf = (chain: Chain): SettingBounds => {
  let bounds: SettingBounds = { min: null, max: null, allowed: null };
  for (const { level, entry } of chain) {
    if (entry === undefined) {
      continue;
    }
    const { min, max, allowed } = entry;
    const { min: least, max: most } = bounds;
    bounds = {
      min:
        min === undefined || (least !== null && min <= least.value)
          ? least
          : most !== null && min > most.value
            ? most
            : { value: min, level },
      max:
        max === undefined || (most !== null && max >= most.value)
          ? most
          : least !== null && max < least.value
            ? least
            : { value: max, level },
      allowed:
        allowed === undefined
          ? bounds.allowed
          : {
              values:
                bounds.allowed === null
                  ? allowed
                  : bounds.allowed.values.filter((value) => allowed.includes(value)),
              level,
            },
    };
  }
  return bounds;
};

/** The bound a value crosses, with which end of it; none for a value inside them. */
const crossed = (key: SettingKey, value: SettingValue, bounds: SettingBounds) => {
  if (!numeric(key)) {
    return bounds.allowed !== null && !bounds.allowed.values.includes(value)
      ? ({ end: "allowed", level: bounds.allowed.level } as const)
      : undefined;
  }
  if (bounds.max !== null && rank(value) > bounds.max.value) {
    return { end: "max", level: bounds.max.level, value: bounds.max.value } as const;
  }
  if (bounds.min !== null && rank(value) < bounds.min.value) {
    return { end: "min", level: bounds.min.level, value: bounds.min.value } as const;
  }
  return undefined;
};

const lockedBy = (bounds: SettingBounds) =>
  (bounds.min !== null && bounds.max !== null && bounds.min.value === bounds.max.value) ||
  (bounds.allowed !== null && bounds.allowed.values.length === 1);

/**
 * A quota's chain with what the levels above a level make of it as a bound of most before
 * it: the deployment's value, or the base where it says none, and the least of those said
 * after it. A value said below is held to it; never or no limit is held to it too.
 */
const capped = (key: SettingKey, chain: Chain, base: Base): Chain => {
  if (!isQuota(key)) {
    return chain;
  }
  let cap: SettingBound | null =
    typeof base.value === "number" ? { value: base.value, level: "instance" } : null;
  return chain.flatMap((link) => {
    const value = link.entry?.value;
    if (link.level === "instance") {
      if (value !== undefined) {
        cap = typeof value === "number" ? { value, level: "instance" } : null;
      }
      return [link];
    }
    const held = cap === null ? [] : [{ level: cap.level, entry: { max: cap.value } }];
    if (typeof value === "number" && (cap === null || value < cap.value)) {
      cap = { value, level: link.level };
    }
    return [...held, link];
  });
};

/**
 * The bounds a level is held to, with what the levels above make of a quota as the most:
 * none past it, and no limit under a number.
 */
export const heldBelow = (
  key: SettingKey,
  level: SettingLevel,
  bounds: SettingBounds,
  inherited: SettingEffective,
): SettingBounds => {
  if (!isQuota(key) || level === "instance" || typeof inherited.value !== "number") {
    return bounds;
  }
  if (bounds.max !== null && bounds.max.value <= inherited.value) {
    return bounds;
  }
  const from = LEVELS.find((one) => one === inherited.source) ?? "instance";
  return { ...bounds, max: { value: inherited.value, level: from } };
};

/**
 * What a setting comes to at the end of a chain: the value of the nearest level that says
 * one, or the base, held to every bound of the chain. A value that crosses one is taken as
 * the bound, from the level that sets it; a choice that is not allowed gives way to the
 * nearest one above it that is, and to the first that is allowed where none is. A quota is
 * held to what the levels above make of it as well.
 */
export const resolve = (key: SettingKey, given: Chain, base: Base): SettingEffective => {
  const chain = capped(key, given, base);
  const bounds = boundsOf(chain);
  const locked = lockedBy(bounds);
  const said = [...chain]
    .reverse()
    .flatMap(({ level, entry }) =>
      entry?.value === undefined ? [] : [{ value: entry.value, source: level }],
    );
  const candidates = [
    ...said,
    ...(base.value === undefined ? [] : [{ value: base.value, source: base.source }]),
  ];
  if (!numeric(key)) {
    const fitting = candidates.find(({ value }) => crossed(key, value, bounds) === undefined);
    if (fitting !== undefined) {
      return { ...fitting, locked, clamped: fitting !== candidates[0] };
    }
    const first = bounds.allowed?.values[0];
    return first === undefined || bounds.allowed === null
      ? { value: null, source: "default", locked, clamped: false }
      : { value: first, source: bounds.allowed.level, locked, clamped: true };
  }
  const nearest = candidates[0];
  if (
    nearest?.value === null &&
    (SETTINGS[key] as SettingDefinition).deletes === true &&
    !LEVELS.some((one) => one === nearest.source)
  ) {
    // A bound alone deletes nothing: never stays never until some level says when.
    return { ...nearest, locked, clamped: false };
  }
  if (nearest === undefined) {
    // Each node holds sessions to its own, which is no wider than a bound of most.
    return bounds.max === null
      ? { value: null, source: "node", locked, clamped: false }
      : { value: bounds.max.value, source: bounds.max.level, locked, clamped: true };
  }
  const beyond = crossed(key, nearest.value, bounds);
  return beyond === undefined || beyond.end === "allowed"
    ? { ...nearest, locked, clamped: false }
    : { value: beyond.value, source: beyond.level, locked, clamped: true };
};

/**
 * How long a pinned session that is kept awake sits idle: as long as it likes, from where
 * it is said to stay awake, unless a level holds it to at most a while, which it is held to.
 */
export const awake = (chain: Chain, stays: SettingEffective): SettingEffective => {
  const bounds = boundsOf(chain);
  const locked = lockedBy(bounds);
  return bounds.max === null
    ? { value: null, source: stays.source, locked, clamped: false }
    : { value: bounds.max.value, source: bounds.max.level, locked, clamped: true };
};

const invalid = (key: SettingKey, message: string) =>
  Result.fail(new SettingInvalid({ key, message }));

/** Whether a value is one of the setting's: a whole number of seconds, a count, a choice. */
const isValue = (key: SettingKey, value: SettingValue) => {
  const { type, none } = SETTINGS[key];
  if (value === null) {
    return none;
  }
  switch (type.kind) {
    case "duration":
      return typeof value === "number" && Number.isInteger(value) && value >= 1;
    case "count":
      return typeof value === "number" && Number.isInteger(value) && value >= 0;
    case "bytes":
      return typeof value === "number" && Number.isInteger(value) && value >= 1;
    case "cpus":
      return typeof value === "number" && Number.isFinite(value) && value > 0;
    case "choice":
      return type.choices.some((choice) => choice === value);
  }
};

const isBound = (key: SettingKey, value: number) =>
  Number.isFinite(value) &&
  value >= 0 &&
  (SETTINGS[key].type.kind === "cpus" || Number.isInteger(value));

/**
 * Whether what a level says of a setting is something it takes there, inside the bounds
 * the levels above it set: a value of its kind, bounds of its kind that do not cross those
 * above, and a value inside its own bounds and theirs.
 */
export const check = (
  key: SettingKey,
  level: SettingLevel,
  entry: SettingEntry,
  above: SettingBounds,
): Result.Result<SettingEntry, SettingInvalid | SettingOutOfBounds> => {
  const definition = SETTINGS[key];
  if (!saidAt(key, level)) {
    return invalid(
      key,
      `${key} is said for ${definition.levels.join(", ")}, and not for a ${level}`,
    );
  }
  const { value, min, max, allowed } = entry;
  if (value !== undefined && !isValue(key, value)) {
    return invalid(key, `${JSON.stringify(value)} is no value of ${key}`);
  }
  if (numeric(key)) {
    if (allowed !== undefined) {
      return invalid(key, `${key} is bounded by min and max, and not by what is allowed`);
    }
    if ((min !== undefined && !isBound(key, min)) || (max !== undefined && !isBound(key, max))) {
      return invalid(key, `a bound of ${key} is a number, none below zero`);
    }
    if (min !== undefined && max !== undefined && min > max) {
      return invalid(key, `the least ${key} is more than the most`);
    }
  } else {
    if (min !== undefined || max !== undefined) {
      return invalid(key, `${key} is bounded by what is allowed, and not by min and max`);
    }
    if (allowed !== undefined) {
      if (allowed.length === 0) {
        return invalid(key, `at least one choice of ${key} is allowed`);
      }
      const unknown = allowed.find((one) => !isValue(key, one) || one === null);
      if (unknown !== undefined) {
        return invalid(key, `${JSON.stringify(unknown)} is no choice of ${key}`);
      }
    }
  }
  const outOfBounds = (bound: SettingLevel, message: string) =>
    Result.fail(new SettingOutOfBounds({ key, level: bound, message }));
  if (above.min !== null && min !== undefined && min < above.min.value) {
    return outOfBounds(
      above.min.level,
      `the ${above.min.level} holds ${key} to at least ${above.min.value}`,
    );
  }
  if (above.max !== null && max !== undefined && max > above.max.value) {
    return outOfBounds(
      above.max.level,
      `the ${above.max.level} holds ${key} to at most ${above.max.value}`,
    );
  }
  if (above.min !== null && max !== undefined && max < above.min.value) {
    return outOfBounds(
      above.min.level,
      `the ${above.min.level} holds ${key} to at least ${above.min.value}`,
    );
  }
  if (above.max !== null && min !== undefined && min > above.max.value) {
    return outOfBounds(
      above.max.level,
      `the ${above.max.level} holds ${key} to at most ${above.max.value}`,
    );
  }
  if (above.allowed !== null && allowed !== undefined) {
    const beyond = allowed.find((one) => !above.allowed?.values.includes(one));
    if (beyond !== undefined) {
      return outOfBounds(
        above.allowed.level,
        `the ${above.allowed.level} does not allow ${key} to be ${JSON.stringify(beyond)}`,
      );
    }
  }
  if (value !== undefined) {
    const beyond = crossed(key, value, above);
    if (beyond !== undefined) {
      return outOfBounds(
        beyond.level,
        beyond.end === "allowed"
          ? `the ${beyond.level} does not allow ${key} to be ${JSON.stringify(value)}`
          : `the ${beyond.level} holds ${key} to ${beyond.end === "max" ? "at most" : "at least"} ${beyond.value}`,
      );
    }
    const own = boundsOf([{ level, entry }]);
    if (crossed(key, value, own) !== undefined) {
      return invalid(key, `the value of ${key} is outside the bounds said beside it`);
    }
  }
  return Result.succeed(entry);
};
