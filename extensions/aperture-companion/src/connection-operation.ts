import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AuthenticationMethod } from "./oauth.ts";
import { NonEmptyString, Timestamp } from "./schema.ts";
import { storedValue } from "./storage.ts";

const base = { id: NonEmptyString, method: AuthenticationMethod, startedAt: Timestamp };

/** Login progress survives the popup closing for permissions or site login. */
export const ConnectionOperation = Schema.Union([
  Schema.Struct({ ...base, status: Schema.Literal("running") }),
  Schema.Struct({ ...base, status: Schema.Literal("succeeded"), connectionId: NonEmptyString }),
  Schema.Struct({ ...base, status: Schema.Literal("failed"), error: NonEmptyString }),
]);
export type ConnectionOperation = typeof ConnectionOperation.Type;

export const connectionOperation = storedValue(
  "session",
  "apertureCompanionConnectionOperation",
  ConnectionOperation,
);

export function isConnectionRunning(operation: ConnectionOperation | null): boolean {
  return operation?.status === "running" && Date.now() - operation.startedAt < 10 * 60_000;
}

export const clearCompletedConnectionOperation = Effect.fn("clearCompletedConnectionOperation")(
  function* (id: string) {
    const operation = Option.getOrNull(yield* connectionOperation.get);
    if (operation?.id === id && !isConnectionRunning(operation)) yield* connectionOperation.remove;
  },
);
