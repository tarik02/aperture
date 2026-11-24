import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpMethod from "effect/http/HttpMethod";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface Answer {
  readonly status: number;
  /** The body as JSON where it is JSON, and as text otherwise. */
  readonly body: unknown;
}

const Json = Schema.fromJsonString(Schema.Unknown);
const jsonOf = Schema.decodeUnknownOption(Json);

/** A request with a token, whose answer is told whatever its status. */
export const request = Effect.fn("request")(function* (
  base: string,
  token: string,
  method: HttpMethod.HttpMethod,
  path: string,
  body?: unknown,
) {
  const client = yield* HttpClient.HttpClient;
  const asked = HttpClientRequest.make(method)(`${base}${path}`).pipe(
    HttpClientRequest.bearerToken(token),
    body === undefined ? (bare) => bare : HttpClientRequest.bodyJsonUnsafe(body),
  );
  const answered = yield* client.execute(asked);
  const text = yield* answered.text;
  return {
    status: answered.status,
    body: Option.getOrElse(jsonOf(text), () => text),
  } satisfies Answer;
});

/** What an address answers with as bytes, to whoever holds the token: a picture, a recording. */
export const bytes = Effect.fn("bytes")(function* (url: string, token: string) {
  const client = yield* HttpClient.HttpClient;
  const answered = yield* client.execute(
    HttpClientRequest.get(url).pipe(HttpClientRequest.bearerToken(token)),
  );
  return new Uint8Array(yield* answered.arrayBuffer);
});

/**
 * A request to an address that says itself what lets it in, as a link someone was given:
 * it carries no token beside the address.
 */
export const follow = Effect.fn("follow")(function* (
  url: string,
  method: HttpMethod.HttpMethod = "GET",
  body?: Uint8Array,
) {
  const client = yield* HttpClient.HttpClient;
  const asked = HttpClientRequest.make(method)(url);
  const answered = yield* client.execute(
    body === undefined
      ? asked
      : HttpClientRequest.bodyUint8Array(asked, body, "application/octet-stream"),
  );
  return { status: answered.status, bytes: new Uint8Array(yield* answered.arrayBuffer) };
});

/** An answer's body as a check knows it, by the schema of what the check reads. */
export const read = <S extends Schema.ConstraintDecoder<unknown>>(answer: Answer, schema: S) =>
  Schema.decodeUnknownEffect(schema)(answer.body);

/** What an executor says of a call it refused. */
export const Refusal = Schema.Struct({
  code: Schema.String,
  message: Schema.optional(Schema.String),
});

/** Why an executor refused a call, as its answer tells it. */
export const refusal = (answer: Answer) => read(answer, Refusal);
