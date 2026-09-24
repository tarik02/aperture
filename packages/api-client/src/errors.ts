import { Schema } from "effect";

export const ApiErrorBody = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
  }),
});

export type ApiErrorBody = typeof ApiErrorBody.Type;

/**
 * A failed API request. `code` and `message` come from the server's error body when it
 * sent one; `status` is 0 when no HTTP response was received.
 */
export class ApiRequestError extends Schema.TaggedError<ApiRequestError>()("ApiRequestError", {
  code: Schema.String,
  message: Schema.String,
  status: Schema.Number,
}) {}

export const parseApiErrorBody = (body: unknown): ApiErrorBody["error"] | null => {
  const parsed = Schema.decodeUnknownOption(ApiErrorBody)(body);
  return parsed._tag === "Some" ? parsed.value.error : null;
};
