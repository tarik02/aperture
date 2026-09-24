import { Effect, Schema } from "effect";
import { HttpClientResponse, type HttpClientError } from "effect/unstable/http";

export const ApiErrorBody = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
  }),
});

export type ApiErrorBody = typeof ApiErrorBody.Type;

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

/**
 * Maps HTTP and decoding failures to ApiRequestError. Error responses keep the code and
 * message of the server's error body.
 */
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
        HttpClientResponse.schemaBodyJson(ApiErrorBody)(response).pipe(
          Effect.map(({ error }) => new ApiRequestError({ ...error, status: response.status })),
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
