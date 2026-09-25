import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import { CompanionCommand } from "./commands.ts";
import { NonEmptyString, Timestamp } from "./schema.ts";
import { storedValue, storedValuesWithPrefix } from "./storage.ts";

/** A command waiting for access to the origins it needs. */
export const PendingCommand = Schema.Struct({
  command: CompanionCommand,
  origins: Schema.Array(NonEmptyString).check(Schema.isMinLength(1)),
  createdAt: Timestamp,
});
export type PendingCommand = typeof PendingCommand.Type;

/** How long a command waits for access before it fails. */
export const pendingCommandLifetime = Duration.minutes(2);

const keyPrefix = "apertureCompanionPendingCommand:";

export const pendingCommand = (id: string) =>
  storedValue("session", `${keyPrefix}${id}`, PendingCommand);

export const listPendingCommands = storedValuesWithPrefix("session", keyPrefix, PendingCommand);
