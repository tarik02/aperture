import * as Schema from "effect/Schema";

/** A Connect error code, or one that stands for an answer that had none. */
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

/** A request to the executor that could not be made, or that the executor refused. */
export class ExecutorError extends Schema.TaggedError<ExecutorError>()("ExecutorError", {
  code: ExecutorErrorCode,
  message: Schema.String,
  /** The HTTP status the executor answered with, when it answered. */
  status: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {}
