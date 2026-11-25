import type { Access } from "@aperture-browser/control-api";
import { proto } from "@aperture-browser/executor-client";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { SettingOutOfBounds } from "../errors.ts";
import { boundBy } from "./limits.ts";
import type { Effective } from "./service.ts";

/** What of a ticket's access the session's settings leave: what they turn off is taken away. */
export const heldAccess = (access: Access, effective: Effective): Access => {
  const held: { -readonly [K in keyof Access]: Access[K] } = { ...access };
  const clipboard = effective.clipboard.value;
  if (clipboard === "off") {
    delete held.clipboard;
  } else if (clipboard === "ro" && held.clipboard !== undefined) {
    // What is copied comes out of the session to whoever reads it, and none goes in.
    if (held.clipboard.includes("r")) {
      held.clipboard = "r";
    } else {
      delete held.clipboard;
    }
  }
  if (effective.uploads.value === false) {
    delete held.uploads;
  }
  if (effective.downloads.value === false) {
    delete held.downloads;
  }
  if (effective.recording.value === false && held.recordings !== undefined) {
    // What was recorded before is still read.
    if (held.recordings.includes("r")) {
      held.recordings = "r";
    } else {
      delete held.recordings;
    }
  }
  return held;
};

/** The features a session's settings turn off, as the glossary names them. */
const offOf = (effective: Effective) =>
  new Set([
    ...(effective.clipboard.value === "off" ? ["clipboard"] : []),
    ...(effective.uploads.value === false ? ["uploads"] : []),
    ...(effective.downloads.value === false ? ["downloads"] : []),
    ...(effective.recording.value === false ? ["recordings"] : []),
  ]);

/**
 * What a session is to offer on a node, of what the node offers: nothing to say where the
 * settings turn none of it off, for all the node offers.
 */
export const featuresOn = (
  offered: ReadonlyArray<string> | undefined,
  effective: Effective,
): { on: Array<proto.Feature> } | undefined => {
  const off = offOf(effective);
  if (offered === undefined || !offered.some((feature) => off.has(feature))) {
    return undefined;
  }
  return {
    on: offered.flatMap((feature) => {
      const named = proto.Feature[feature.toUpperCase() as keyof typeof proto.Feature];
      return off.has(feature) || named === undefined ? [] : [named];
    }),
  };
};

/**
 * Whether a session offers what its settings leave it, as its node tells: what they say,
 * or all the node offers where they say nothing. Nothing to hold it to on a node that does
 * not tell what it offers.
 */
export const offersAsSaid = (
  told: ReadonlyArray<proto.Feature>,
  wanted: { readonly on: ReadonlyArray<proto.Feature> } | undefined,
  offered: ReadonlyArray<string> | undefined,
) => {
  if (offered === undefined) {
    return true;
  }
  const expected = new Set(
    wanted?.on ??
      offered.flatMap((feature) => {
        const named = proto.Feature[feature.toUpperCase() as keyof typeof proto.Feature];
        return named === undefined ? [] : [named];
      }),
  );
  const has = new Set(told);
  return has.size === expected.size && [...has].every((feature) => expected.has(feature));
};

/**
 * Refuses a lifetime past the most a setting lets something last: one that never runs out
 * where there is a most, and one longer than it.
 */
export const withinLifetime = (
  setting: Effective["shareLinkMaxLifetime"],
  key: "shareLinkMaxLifetime" | "apiTokenMaxLifetime",
  what: string,
  lasts: Duration.Duration | undefined,
  toSeconds: (lasts: Duration.Duration) => number,
) => {
  const most = setting.value;
  if (typeof most !== "number") {
    return Effect.void;
  }
  const level = boundBy(setting);
  if (lasts === undefined) {
    return Effect.fail(
      new SettingOutOfBounds({
        key,
        level,
        message: `the ${level} lets ${what} last ${most} seconds at most, and none for good`,
      }),
    );
  }
  return toSeconds(lasts) > most
    ? Effect.fail(
        new SettingOutOfBounds({
          key,
          level,
          message: `the ${level} lets ${what} last ${most} seconds at most`,
        }),
      )
    : Effect.void;
};
