import * as Effect from "effect/Effect";

/** What the automation endpoint refused, or a tool failed with. */
export class McpError extends Error {
  constructor(asked: string, reason: string) {
    super(`${asked}: ${reason}`);
    this.name = "McpError";
  }
}

/** A session's automation, as an agent reaches it. */
export interface Mcp {
  /** Calls a tool and gives the text it answered with. A tool that fails is an error. */
  readonly call: (name: string, args?: object) => Effect.Effect<string, McpError>;
  /** The names of the tools the session has. */
  readonly tools: Effect.Effect<readonly string[], McpError>;
}

interface Content {
  readonly type: string;
  readonly text?: string;
}

interface ToolResult {
  readonly content: readonly Content[];
  readonly isError?: boolean;
}

interface Answer {
  // A result is as many shapes as there are methods; each caller reads the one it asked for.
  // oxlint-disable-next-line typescript/no-explicit-any
  readonly result?: any;
  readonly error?: unknown;
}

/** The answer is JSON, or the last event of a stream of them. */
const answerOf = (body: string): Answer => {
  if (body.startsWith("{")) {
    return JSON.parse(body) as Answer;
  }
  const last = body
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .at(-1);
  if (last === undefined) {
    throw new Error(`no answer in ${JSON.stringify(body.slice(0, 200))}`);
  }
  return JSON.parse(last.slice("data: ".length)) as Answer;
};

/** Connects to the automation endpoint of the session at `url`, as whoever holds `token`. */
export const connect = (url: string, token: string): Effect.Effect<Mcp, McpError> =>
  Effect.gen(function* () {
    let session: string | undefined;
    let last = 0;

    const send = (method: string, params: object, id: number | undefined) =>
      Effect.tryPromise({
        try: async () => {
          const answered = await fetch(`${url}/mcp`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              ...(session === undefined ? {} : { "Mcp-Session-Id": session }),
            },
            body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
          });
          session ??= answered.headers.get("mcp-session-id") ?? undefined;
          const body = await answered.text();
          if (id === undefined) {
            return undefined;
          }
          if (!answered.ok) {
            throw new Error(`${answered.status} ${body.slice(0, 200)}`);
          }
          const answer = answerOf(body);
          if (answer.error !== undefined) {
            throw new Error(JSON.stringify(answer.error));
          }
          return answer.result;
        },
        catch: (cause) =>
          new McpError(method, cause instanceof Error ? cause.message : String(cause)),
      });

    const ask = (method: string, params: object) => {
      last += 1;
      return send(method, params, last);
    };

    yield* ask("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "e2e", version: "0" },
    });
    yield* send("notifications/initialized", {}, undefined);

    return {
      call: (name, args = {}) =>
        ask("tools/call", { name, arguments: args }).pipe(
          Effect.flatMap((result: ToolResult) => {
            const text = result.content
              .map((item) => item.text ?? "")
              .join("\n")
              .trim();
            return result.isError === true
              ? Effect.fail(new McpError(name, text))
              : Effect.succeed(text);
          }),
        ),
      tools: ask("tools/list", {}).pipe(
        Effect.map((result: { tools: readonly { name: string }[] }) =>
          result.tools.map((tool) => tool.name),
        ),
      ),
    } satisfies Mcp;
  });
