import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";

export const ApiErrorBody = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
  }),
});

export type ApiErrorBody = typeof ApiErrorBody.Type;

/**
 * The error body of a live-session route that failed inside the running session. It carries
 * no stable code, so the resulting ApiRequestError uses `live_session_error` and callers
 * branch on its status.
 */
export const LiveSessionErrorBody = Schema.Struct({
  error: Schema.String,
});

export type LiveSessionErrorBody = typeof LiveSessionErrorBody.Type;

const ErrorResponseBody = Schema.Union([ApiErrorBody, LiveSessionErrorBody]);

/**
 * A failed API request. `code` and `message` come from the server's error body when it
 * sent one; `status` is 0 when no HTTP status applies.
 */
export class ApiRequestError extends Schema.TaggedError<ApiRequestError>()("ApiRequestError", {
  code: Schema.String,
  message: Schema.String,
  status: Schema.Number,
}) {}

const invalidResponse = (status: number) =>
  new ApiRequestError({ code: "internal_error", message: "Invalid response", status });

const networkError = new ApiRequestError({
  code: "network_error",
  message: "The server could not be reached",
  status: 0,
});

/**
 * Maps HTTP and decoding failures to ApiRequestError. Error responses keep the code and
 * message of the server's error body.
 */
export const toApiRequestError = <A, R>(
  self: Effect.Effect<A, HttpClientError.HttpClientError | Schema.SchemaError, R>,
): Effect.Effect<A, ApiRequestError, R> =>
  self.pipe(
    Effect.catchReasons("HttpClientError", {
      StatusCodeError: ({ response }) =>
        HttpClientResponse.schemaBodyJson(ErrorResponseBody)(response).pipe(
          Effect.map(({ error }) =>
            typeof error === "string"
              ? new ApiRequestError({
                  code: "live_session_error",
                  message: error,
                  status: response.status,
                })
              : new ApiRequestError({ ...error, status: response.status }),
          ),
          Effect.orElseSucceed(
            () =>
              new ApiRequestError({
                code: "internal_error",
                message: "Request failed",
                status: response.status,
              }),
          ),
          Effect.flatMap(Effect.fail),
        ),
      DecodeError: ({ response }) => Effect.fail(invalidResponse(response.status)),
    }),
    Effect.catchTags({
      HttpClientError: () => Effect.fail(networkError),
      SchemaError: () => Effect.fail(invalidResponse(0)),
    }),
  );
