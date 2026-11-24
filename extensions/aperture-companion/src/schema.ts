import * as Schema from "effect/Schema";

export const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
export const TabId = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));
export const Timestamp = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
export const Tags = Schema.Record(Schema.String, Schema.String);
export type Tags = typeof Tags.Type;

/** Tags a teleported session or snapshot starts with. */
export const defaultTeleportTags: Tags = { source: "aperture-companion", action: "teleport" };

export const TeleportDestination = Schema.Literals(["session", "snapshot"]);
export type TeleportDestination = typeof TeleportDestination.Type;
