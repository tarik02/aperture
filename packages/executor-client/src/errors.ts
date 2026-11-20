import { ConnectError } from "@connectrpc/connect";
import { codeToString } from "@connectrpc/connect/protocol-connect";
import * as Schema from "effect/Schema";

/** A Connect error code. */
export const ExecutorErrorCode = Schema.Literals([
  "canceled",
  "unknown",
  "invalid_argument",
  "deadline_exceeded",
  "not_found",
  "already_exists",
  "permission_denied",
  "resource_exhausted",
  "failed_precondition",
  "aborted",
  "out_of_range",
  "unimplemented",
  "internal",
  "unavailable",
  "data_loss",
  "unauthenticated",
]);
export type ExecutorErrorCode = typeof ExecutorErrorCode.Type;

const isCode = Schema.is(ExecutorErrorCode);

/** A request to the executor that could not be made, or that the executor refused. */
export class ExecutorError extends Schema.TaggedError<ExecutorError>()("ExecutorError", {
  code: ExecutorErrorCode,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  /** What a call that did not give its answer failed with. */
  static from(cause: unknown): ExecutorError {
    const failed = ConnectError.from(cause);
    const code = codeToString(failed.code);
    return new ExecutorError({
      code: isCode(code) ? code : "unknown",
      message: failed.rawMessage,
      cause,
    });
  }
}
