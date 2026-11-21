import type { Caller } from "@aperture-browser/control-api";
import * as UrlPath from "@aperture-browser/shared/url-path";
import * as McpSchema from "effect/ai/McpSchema";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { accountOf } from "../accounts/caller.ts";
import { NodeRefused, NodeUnreachable } from "../errors.ts";
import type { Node } from "../nodes/schemas.ts";
import { Nodes } from "../nodes/service.ts";
import { Sessions } from "../sessions/service.ts";
import { SessionsStore } from "../sessions/store.ts";
import { Tickets } from "../tickets/service.ts";
import { SessionTools } from "./service.ts";

const PROTOCOL = "2025-06-18";
/** The header a session's server names a connection to it in. */
const CONNECTION = "mcp-session-id";
const NOT_FOUND = 404;
/** What a node's sessions offer where they have a server of their own. */
const FEATURE = "mcp";
const SHOWN = 300;

/** A session on its node, and what lets the request to it in. */
interface At {
  readonly node: Node;
  readonly sessionId: string;
  readonly bearer: string;
}

interface Message {
  readonly id?: number;
  readonly method: string;
  readonly params: object;
}

// A result is as many shapes as there are methods; each asker reads the one it asked for.
const Answer = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Struct({ code: Schema.Number, message: Schema.String })),
  }),
);
const decodeAnswer = Schema.decodeUnknownEffect(Answer);
const decodeTools = Schema.decodeUnknownEffect(McpSchema.ListToolsResult);
const decodeResult = Schema.decodeUnknownEffect(McpSchema.CallToolResult);

/** The answer is JSON, or the last event of a stream of them. */
const answerIn = (body: string) =>
  body.startsWith("{")
    ? body
    : body
        .split("\n")
        .filter((line) => line.startsWith("data: {"))
        .at(-1)
        ?.slice("data: ".length);

export const makeSessionTools = Effect.fn("SessionTools.make")(function* () {
  const client = yield* HttpClient.HttpClient;
  const sessions = yield* Sessions;
  const store = yield* SessionsStore;
  const nodes = yield* Nodes;
  const tickets = yield* Tickets;
  /** The connection each session's server knows this program by. */
  const connections = new Map<string, string>();
  /** The tools sessions have, by the version of the node whose session told them. */
  const learnt = new Map<string, ReadonlyArray<McpSchema.Tool>>();
  let asked = 0;

  const refused = (at: At, code: string, message: string) =>
    new NodeRefused({ node: at.node.name, code, message });

  const send = Effect.fn(function* (at: At, connection: string | undefined, message: Message) {
    const url = UrlPath.make`${UrlPath.raw(at.node.internalUrl)}/sessions/${at.sessionId}/mcp`;
    return yield* client
      .execute(
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.bearerToken(at.bearer),
          HttpClientRequest.setHeaders({
            accept: "application/json, text/event-stream",
            ...(connection === undefined
              ? {}
              : { [CONNECTION]: connection, "mcp-protocol-version": PROTOCOL }),
          }),
          HttpClientRequest.bodyJsonUnsafe({ jsonrpc: "2.0", ...message }),
        ),
      )
      .pipe(
        Effect.flatMap((answered) =>
          Effect.map(answered.text, (body) => ({
            status: answered.status,
            connection: answered.headers[CONNECTION],
            body,
          })),
        ),
        Effect.mapError(
          (error) => new NodeUnreachable({ node: at.node.name, message: error.message }),
        ),
      );
  });

  const resultOf = Effect.fn(function* (at: At, answered: Effect.Success<ReturnType<typeof send>>) {
    if (answered.status < 200 || answered.status >= 300) {
      return yield* refused(
        at,
        String(answered.status),
        answered.body.slice(0, SHOWN) || `the session's server answered ${answered.status}`,
      );
    }
    const answer = yield* decodeAnswer(answerIn(answered.body)).pipe(
      Effect.mapError((error) => refused(at, "invalid", error.message)),
    );
    if (answer.error !== undefined) {
      return yield* refused(at, String(answer.error.code), answer.error.message);
    }
    return answer.result;
  });

  const next = () => {
    asked += 1;
    return asked;
  };

  const open = Effect.fn(function* (at: At) {
    const answered = yield* send(at, undefined, {
      id: next(),
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: "aperture-control", version: "0" },
      },
    });
    yield* resultOf(at, answered);
    if (answered.connection !== undefined) {
      connections.set(at.sessionId, answered.connection);
      yield* send(at, answered.connection, { method: "notifications/initialized", params: {} });
    }
    return answered.connection;
  });

  /** Asks the session's server, over the connection it has to it, or over a new one. */
  const ask = Effect.fn("SessionTools.ask")(function* (at: At, method: string, params: object) {
    const kept = connections.get(at.sessionId);
    const answered = yield* send(at, kept ?? (yield* open(at)), { id: next(), method, params });
    // A session that was suspended since runs another server, which knows no connection
    // of the one before it; it did nothing of what was asked.
    if (kept !== undefined && answered.status === NOT_FOUND) {
      connections.delete(at.sessionId);
      const again = yield* send(at, yield* open(at), { id: next(), method, params });
      return yield* resultOf(at, again);
    }
    return yield* resultOf(at, answered);
  });

  const toolsAt = Effect.fn(function* (at: At) {
    const listed = yield* ask(at, "tools/list", {}).pipe(
      Effect.flatMap(decodeTools),
      Effect.catchTag("SchemaError", (error) => Effect.fail(refused(at, "invalid", error.message))),
    );
    return listed.tools;
  });

  /** Asks a session that runs on a node of each version nobody asked yet, where one does. */
  const learn = Effect.fn("SessionTools.learn")(function* () {
    const listed = yield* nodes.list();
    const unknown = new Set(
      listed.flatMap(({ node, alive }) =>
        alive &&
        node.offers !== null &&
        node.offers.features.includes(FEATURE) &&
        !learnt.has(node.offers.version)
          ? [node.offers.version]
          : [],
      ),
    );
    if (unknown.size === 0) {
      return;
    }
    const running = (yield* store.list()).filter((session) => session.observedState === "running");
    for (const node of yield* nodes.alive()) {
      const version = node.offers?.version;
      const session = running.find((one) => one.nodeId === node.id);
      if (version === undefined || !unknown.has(version) || session === undefined) {
        continue;
      }
      // It is this program that asks, and of what is no secret: no caller is there to ask as.
      const told = yield* toolsAt({
        node,
        sessionId: session.id,
        bearer: node.operatorToken,
      }).pipe(
        Effect.tapError((error) =>
          Effect.logDebug(`session ${session.id} did not tell its tools: ${error.message}`),
        ),
        Effect.option,
      );
      if (told._tag === "Some") {
        learnt.set(version, told.value);
        unknown.delete(version);
      }
    }
  });

  const known = Effect.fn("SessionTools.known")(function* () {
    yield* learn();
    // Where versions differ in a tool, the one that was asked last has it as it is told.
    const byName = new Map<string, McpSchema.Tool>();
    for (const tools of learnt.values()) {
      for (const tool of tools) {
        byName.set(tool.name, tool);
      }
    }
    return [...byName.values()];
  });

  /**
   * The caller's session with a ticket of theirs into its automation and nothing else:
   * the node lets the call in as it lets them in, and is told who they are.
   */
  const reached = Effect.fn(function* (caller: Caller, sessionId: string) {
    const account = yield* accountOf(caller);
    const { node } = yield* sessions.placed(caller, sessionId);
    const issued = yield* tickets.issue({
      sessionId,
      subject: account.id,
      name: account.name,
      access: { mcp: "rw" },
    });
    return { node, sessionId, bearer: issued.ticket } satisfies At;
  });

  const of = Effect.fn("SessionTools.of")(function* (caller: Caller, sessionId: string) {
    return yield* toolsAt(yield* reached(caller, sessionId));
  });

  const call = Effect.fn("SessionTools.call")(function* (
    caller: Caller,
    sessionId: string,
    name: string,
    args: Readonly<Record<string, unknown>>,
  ) {
    const at = yield* reached(caller, sessionId);
    return yield* ask(at, "tools/call", { name, arguments: args }).pipe(
      Effect.flatMap(decodeResult),
      Effect.catchTag("SchemaError", (error) => Effect.fail(refused(at, "invalid", error.message))),
    );
  });

  return SessionTools.of({ known, of, call });
});

export const layer = Layer.effect(SessionTools, makeSessionTools());
