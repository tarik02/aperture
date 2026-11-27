import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schema from "effect/Schema";
import { SmokeFailed } from "../errors.ts";

/** A tab as a session tells of it at `/targets`. */
export const Targets = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      url: Schema.optional(Schema.String),
      title: Schema.optional(Schema.String),
    }),
  ),
);
export type Targets = typeof Targets.Type;

/** The page a session is asked to load over HTTPS, as it is once loaded. */
export const PAGE = { url: "https://example.com/", title: "Example Domain" };

export const loaded = (targets: Targets) =>
  targets.some((target) => target.url === PAGE.url && target.title === PAGE.title);

/**
 * Asks every second, for as long as given, until what is asked is so; what answers in a
 * way that cannot be read is not so yet. `alive` fails where what is asked has ended, and
 * nothing is to come.
 */
export const until = Effect.fn("until")(function* <E, R>(
  what: string,
  seconds: number,
  asked: Effect.Effect<boolean, unknown, R>,
  alive: Effect.Effect<void, E, R> = Effect.void,
) {
  for (let waited = 0; waited < seconds; waited += 1) {
    if (yield* asked.pipe(Effect.orElseSucceed(() => false))) {
      return;
    }
    yield* alive;
    yield* Effect.sleep("1 second");
  }
  return yield* new SmokeFailed({ reason: `${what} within ${seconds} seconds` });
});

/** What answers at an address, as long as it answers with no error status. */
export const answer = Effect.fn("answer")(function* (
  url: string,
  token: string | undefined,
  seconds: number,
) {
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const request = HttpClientRequest.get(url);
  const answered = yield* client
    .execute(token === undefined ? request : HttpClientRequest.bearerToken(request, token))
    .pipe(
      Effect.flatMap((response) => response.text),
      Effect.timeout(`${seconds} seconds`),
    );
  return answered;
});

/** The tabs a session tells of now. */
export const targets = (url: string, token: string) =>
  answer(`${url}/targets`, token, 5).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Targets)));

const PROTOCOL = "2025-06-18";

/** Asks a session over MCP, as an agent does, to load the page over HTTPS. */
export const navigate = Effect.fn("navigate")(function* (url: string, token: string) {
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const call = (body: object, headers: Record<string, string> = {}) =>
    client
      .execute(
        HttpClientRequest.post(`${url}/mcp`).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.setHeaders({
            Accept: "application/json, text/event-stream",
            ...headers,
          }),
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
      )
      .pipe(
        Effect.flatMap((response) => Effect.as(response.text, response.headers)),
        Effect.timeout("60 seconds"),
        Effect.mapError(
          (error) => new SmokeFailed({ reason: `the session's MCP endpoint: ${error.message}` }),
        ),
      );
  const headers = yield* call({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "smoke", version: "0" },
    },
  });
  const session = headers["mcp-session-id"];
  if (session === undefined) {
    return yield* new SmokeFailed({ reason: "the session's MCP endpoint gave no session id" });
  }
  const agreed = { "mcp-session-id": session, "mcp-protocol-version": PROTOCOL };
  yield* call({ jsonrpc: "2.0", method: "notifications/initialized" }, agreed);
  yield* call(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "navigate", arguments: { url: PAGE.url } },
    },
    agreed,
  );
});
