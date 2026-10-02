import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { NonEmptyString, TeleportDestination, Timestamp } from "./schema.ts";
import { storedValue } from "./storage.ts";

export const TeleportStage = Schema.Literals([
  "requesting-access",
  "capturing",
  "creating-session",
  "creating-snapshot",
  "opening",
]);
export type TeleportStage = typeof TeleportStage.Type;

const base = { id: NonEmptyString, destination: TeleportDestination, startedAt: Timestamp };

/** The latest teleport, which the popup shows even when it was reopened meanwhile. */
export const TeleportOperation = Schema.Union([
  Schema.Struct({ ...base, status: Schema.Literal("running"), stage: TeleportStage }),
  Schema.Struct({
    ...base,
    status: Schema.Literal("succeeded"),
    completedAt: Timestamp,
    warnings: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    ...base,
    status: Schema.Literal("failed"),
    completedAt: Timestamp,
    error: NonEmptyString,
  }),
]);
export type TeleportOperation = typeof TeleportOperation.Type;

// A running operation older than this was cut short, e.g. by the service worker stopping.
const operationTimeout = Duration.minutes(10);

export const teleportOperation = storedValue(
  "session",
  "apertureCompanionTeleportOperation",
  TeleportOperation,
);

export function isTeleportRunning(
  operation: TeleportOperation | null,
): operation is Extract<TeleportOperation, { status: "running" }> {
  return (
    operation?.status === "running" &&
    Date.now() - operation.startedAt < Duration.toMillis(operationTimeout)
  );
}

/** Forgets the operation once the popup has shown how it ended. */
export const clearCompletedTeleportOperation = Effect.fnUntraced(function* (id: string) {
  const operation = Option.getOrNull(yield* teleportOperation.get);
  if (operation?.id === id && !isTeleportRunning(operation)) yield* teleportOperation.remove;
});
