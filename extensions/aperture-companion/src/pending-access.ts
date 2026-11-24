import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { CompanionError, hasOrigins } from "./chrome.ts";
import { connectionOperation } from "./connection-operation.ts";
import { listPendingCommands, pendingCommand, type PendingCommand } from "./pending-command.ts";
import { teleportOperation } from "./teleport-operation.ts";

// A command waits in the worker for the sites it needs: the browser's prompt takes the
// focus, the popup closes over it, and the grant comes after. Where the prompt ended with
// no answer instead, nothing asks the person any more, and the command would wait until
// it runs out. What is here finds such a command, and takes it back.

/**
 * A command that waits for sites the extension has not been given, and has done nothing
 * yet; none where every pending command has its sites or is under way.
 */
export const awaitingAccess = Effect.gen(function* () {
  for (const pending of yield* listPendingCommands) {
    if (pending.teleport === undefined && !(yield* hasOrigins(pending.origins))) {
      return pending satisfies PendingCommand;
    }
  }
  return null;
});

/**
 * Takes back a command that waits for access, with what tells of it as in progress: the
 * popup that opens next finds nothing to go on with. One that is under way is not taken
 * back. Answers the command that was taken back; none where it was gone already.
 */
export const cancelPending = Effect.fn("cancelPending")(function* (commandId: string) {
  const stored = pendingCommand(commandId);
  const pending = Option.getOrNull(yield* stored.get);
  if (pending === null) return null;
  if (pending.teleport !== undefined) {
    return yield* new CompanionError({ message: "The teleport is under way already" });
  }
  yield* stored.remove;
  if (pending.command.type === "teleport-tabs") {
    const told = Option.getOrNull(yield* teleportOperation.get);
    if (told?.id === commandId) yield* teleportOperation.remove;
  } else {
    const told = Option.getOrNull(yield* connectionOperation.get);
    if (told?.id === commandId) yield* connectionOperation.remove;
  }
  return pending;
});
