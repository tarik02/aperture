import * as Schema from "effect/Schema";

/** A request to the session that could not be made, or that the session refused. */
export class SessionError extends Schema.TaggedError<SessionError>()("SessionError", {
  message: Schema.String,
  /** The HTTP status the session answered with, when it answered. */
  status: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {}
