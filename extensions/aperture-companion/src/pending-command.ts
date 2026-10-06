import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { CompanionError } from "./chrome.ts";
import { CompanionCommand } from "./commands.ts";
import { NonEmptyString, Timestamp } from "./schema.ts";
import { storedValue, storedValuesWithPrefix } from "./storage.ts";

const teleportCheckpointBase = {
  connectionId: NonEmptyString,
  warnings: Schema.Array(Schema.String),
};

export const TeleportCheckpoint = Schema.Union([
  Schema.Struct({ ...teleportCheckpointBase, stage: Schema.Literal("creating") }),
  Schema.Struct({
    ...teleportCheckpointBase,
    stage: Schema.Literals(["restoring", "promoting", "opening"]),
    sessionId: NonEmptyString,
  }),
]);
export type TeleportCheckpoint = typeof TeleportCheckpoint.Type;

/** A command waiting for permissions or finishing a session it already created. */
export const PendingCommand = Schema.Struct({
  command: CompanionCommand,
  origins: Schema.Array(NonEmptyString).check(Schema.isMinLength(1)),
  createdAt: Timestamp,
  teleport: Schema.optionalKey(TeleportCheckpoint),
});
export type PendingCommand = typeof PendingCommand.Type;

/** How long a command waits for access before it fails. */
export const pendingCommandLifetime = Duration.minutes(2);

const keyPrefix = "apertureCompanionPendingCommand:";

export const pendingCommand = (id: string) =>
  storedValue("session", `${keyPrefix}${id}`, PendingCommand);

export const listPendingCommands = storedValuesWithPrefix("session", keyPrefix, PendingCommand);

export const saveTeleportCheckpoint = Effect.fn("saveTeleportCheckpoint")(function* (
  id: string,
  teleport: TeleportCheckpoint,
) {
  const stored = pendingCommand(id);
  const pending = Option.getOrNull(yield* stored.get);
  if (pending === null) {
    return yield* new CompanionError({ message: "The teleport is no longer pending" });
  }
  yield* stored.set({ ...pending, teleport });
});
