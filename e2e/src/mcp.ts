import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schema from "effect/Schema";

/** What the automation endpoint refused, or a tool failed with. */
export class McpError extends Schema.TaggedError<McpError>()("McpError", {
  asked: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `${this.asked}: ${this.reason}`;
  }
}

/** A part of what a tool answered with: text, or a picture as `data`. */
export const Content = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
  data: Schema.optional(Schema.String),
});
export type Content = typeof Content.Type;

/** A session's automation, as an agent reaches it. */
export interface Mcp {
  /** Calls a tool and gives the text it answered with. A tool that fails is an error. */
  readonly call: (name: string, args?: object) => Effect.Effect<string, McpError>;
  /** Calls a tool and gives all it answered with, text and other than text. */
  readonly content: (name: string, args?: object) => Effect.Effect<readonly Content[], McpError>;
  /** The names of the tools the session has. */
  readonly tools: Effect.Effect<readonly string[], McpError>;
}

const ToolResult = Schema.Struct({
  content: Schema.Array(Content),
  isError: Schema.optional(Schema.Boolean),
});

const Tools = Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) });

// A result is as many shapes as there are methods; each caller reads the one it asked for.
const Answer = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Unknown),
  }),
);

const SESSION = "mcp-session-id";

/** The answer is JSON, or the last event of a stream of them. */
const answerIn = (body: string) => {
  if (body.startsWith("{")) {
    return body;
  }
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .at(-1)
    ?.slice("data: ".length);
};

/** Connects to the automation endpoint of the session at `url`, as whoever holds `token`. */
export const connect = Effect.fn("Mcp.connect")(function* (url: string, token: string) {
  const client = yield* HttpClient.HttpClient;
  let session: string | undefined;
  let last = 0;

  const send = Effect.fn(function* (method: string, params: object, id: number | undefined) {
    const refused = (reason: string) => new McpError({ asked: method, reason });
    const answered = yield* client
      .execute(
        HttpClientRequest.post(`${url}/mcp`).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.setHeaders({
            Accept: "application/json, text/event-stream",
            ...(session === undefined ? {} : { [SESSION]: session }),
          }),
          HttpClientRequest.bodyJsonUnsafe({ jsonrpc: "2.0", id, method, params }),
        ),
      )
      .pipe(Effect.mapError((error) => refused(error.message)));
    session ??= answered.headers[SESSION];
    const body = yield* answered.text.pipe(Effect.mapError((error) => refused(error.message)));
    if (id === undefined) {
      return undefined;
    }
    if (answered.status < 200 || answered.status >= 300) {
      return yield* refused(`${answered.status} ${body.slice(0, 200)}`);
    }
    const told = answerIn(body);
    if (told === undefined) {
      return yield* refused(`no answer in ${JSON.stringify(body.slice(0, 200))}`);
    }
    const answer = yield* Schema.decodeUnknownEffect(Answer)(told).pipe(
      Effect.mapError((error) => refused(error.message)),
    );
    if (answer.error !== undefined) {
      return yield* refused(JSON.stringify(answer.error));
    }
    return answer.result;
  });

  const ask = <S extends Schema.ConstraintDecoder<unknown>>(
    method: string,
    params: object,
    result: S,
  ) =>
    Effect.suspend(() => {
      last += 1;
      return send(method, params, last);
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(result)),
      Effect.catchTag("SchemaError", (error) =>
        Effect.fail(new McpError({ asked: method, reason: error.message })),
      ),
    );

  yield* ask(
    "initialize",
    {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "e2e", version: "0" },
    },
    Schema.Unknown,
  );
  yield* send("notifications/initialized", {}, undefined);

  const textOf = (content: readonly Content[]) =>
    content
      .map((item) => item.text ?? "")
      .join("\n")
      .trim();

  const content: Mcp["content"] = (name, args = {}) =>
    ask("tools/call", { name, arguments: args }, ToolResult).pipe(
      Effect.flatMap((result) =>
        result.isError === true
          ? Effect.fail(new McpError({ asked: name, reason: textOf(result.content) }))
          : Effect.succeed(result.content),
      ),
    );

  return {
    call: (name, args) => content(name, args).pipe(Effect.map(textOf)),
    content,
    tools: ask("tools/list", {}, Tools).pipe(
      Effect.map((result) => result.tools.map((tool) => tool.name)),
    ),
  } satisfies Mcp;
});
