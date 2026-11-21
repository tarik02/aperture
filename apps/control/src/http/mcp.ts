import { covers, CurrentCaller, type Scope } from "@aperture-browser/control-api";
import * as McpProtocol from "effect/ai/McpProtocol";
import * as McpSchema from "effect/ai/McpSchema";
import * as McpServer from "effect/ai/McpServer";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { Accounts } from "../accounts/service.ts";
import { Forbidden } from "../errors.ts";
import { SessionTools, type SessionToolError } from "../mcp/service.ts";
import { ControlTools } from "../mcp/toolkit.ts";
import { Sessions } from "../sessions/service.ts";
import { Settings } from "../settings/service.ts";
import { Snapshots } from "../snapshots/service.ts";
import { callerOf } from "./caller.ts";
import { told } from "./handlers.ts";
import { anyOrigin, originOf } from "./origin.ts";

/** Where agents reach every session their token does, over MCP. */
export const PATH = "/mcp";

/** Where a client learns what authorizes it for this server, as RFC 9728 has it. */
export const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
const UNAUTHORIZED = 401;
/** What a page of another origin reads of an answer beside its body. */
const EXPOSED = ["www-authenticate", "mcp-session-id"];
const SESSION_ID = "session_id";

const INSTRUCTIONS = `Aperture runs isolated browser sessions that people and agents watch and control together.

Create a session with sessions.create, or find one with sessions.list. The browser, recording and file tools act in the session named by their session_id. A session created from a snapshot starts with that snapshot's profile: signed in where it was. Suspend a session you are done with for now, and delete one nobody needs.`;

/**
 * Who calls a tool, where their token covers the scope. Every request to the server is
 * told its caller before a tool is called, so one without is a fault of this program.
 */
const calling = (scope: Scope) =>
  Effect.serviceOption(CurrentCaller).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.die("a tool was called by nobody"),
        onSome: (caller) =>
          covers(caller.scopes, scope)
            ? Effect.succeed(caller)
            : Effect.fail(new Forbidden({ message: `this token is not for ${scope}` })),
      }),
    ),
  );

const handlers = ControlTools.toLayer(
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const snapshots = yield* Snapshots;
    return {
      "sessions.list": () =>
        calling("sessions:read").pipe(
          Effect.flatMap(sessions.list),
          Effect.map((all) => ({ sessions: all.map(told) })),
        ),
      "sessions.get": ({ session_id }) =>
        Effect.flatMap(calling("sessions:read"), (caller) => sessions.get(caller, session_id)).pipe(
          Effect.map(told),
        ),
      "sessions.create": (asked) =>
        Effect.flatMap(calling("sessions:write"), (caller) =>
          sessions.create(caller, {
            suspended: false,
            snapshotId: asked.snapshot_id,
            label: asked.label,
            workspaceId: asked.workspace_id,
            proxy: asked.proxy,
            tags: asked.tags ?? {},
          }),
        ).pipe(Effect.map(told)),
      "sessions.update": ({ session_id, label, tags }) =>
        Effect.flatMap(calling("sessions:write"), (caller) =>
          sessions.describe(caller, session_id, { label, tags }),
        ).pipe(Effect.map(told)),
      "sessions.suspend": ({ session_id }) =>
        Effect.flatMap(calling("sessions:write"), (caller) =>
          sessions.suspend(caller, session_id),
        ).pipe(Effect.map(told)),
      "sessions.resume": ({ session_id }) =>
        Effect.flatMap(calling("sessions:write"), (caller) =>
          sessions.resume(caller, session_id),
        ).pipe(Effect.map(told)),
      "sessions.delete": ({ session_id }) =>
        Effect.flatMap(calling("sessions:write"), (caller) =>
          sessions.delete(caller, session_id),
        ).pipe(Effect.as({ deleted: session_id })),
      "sessions.promote": (asked) =>
        Effect.flatMap(calling("snapshots:write"), (caller) =>
          snapshots.take(caller, asked.session_id, {
            name: asked.name,
            description: asked.description,
            tags: asked.tags,
            replaces: asked.replaces,
          }),
        ),
      "snapshots.list": () =>
        calling("snapshots:read").pipe(
          Effect.flatMap(snapshots.list),
          Effect.map((all) => ({ snapshots: all })),
        ),
      "snapshots.get": ({ snapshot_id }) =>
        Effect.flatMap(calling("snapshots:read"), (caller) => snapshots.get(caller, snapshot_id)),
      "snapshots.update": ({ snapshot_id, ...described }) =>
        Effect.flatMap(calling("snapshots:write"), (caller) =>
          snapshots.describe(caller, snapshot_id, described),
        ),
      "snapshots.delete": ({ snapshot_id }) =>
        Effect.flatMap(calling("snapshots:write"), (caller) =>
          snapshots.delete(caller, snapshot_id),
        ).pipe(Effect.as({ deleted: snapshot_id })),
    };
  }),
);

const failed = (text: string) =>
  new McpSchema.CallToolResult({ isError: true, content: [{ type: "text", text }] });

const refusal = (error: SessionToolError) => {
  switch (error._tag) {
    case "SessionNotFound":
      return failed(`there is no session ${error.id}`);
    case "SessionHasNoNode":
      return failed(`the session ${error.id} is on no node`);
    default:
      return failed(error.message);
  }
};

/** A session's tool as this server has it: for the session its `session_id` names. */
const forSession = ({ name, title, description, inputSchema, annotations }: McpSchema.Tool) => {
  const { properties, required, ...rest } = inputSchema;
  return new McpSchema.Tool({
    name,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(annotations === undefined ? {} : { annotations }),
    inputSchema: {
      ...rest,
      properties: {
        [SESSION_ID]: { type: "string", description: "The session to act in." },
        ...properties,
      },
      required: [SESSION_ID, ...(required ?? [])],
    },
  });
};

const SESSION_TOOLS = new McpSchema.Tool({
  name: "sessions.tools",
  description:
    "List the tools of a running session as the session itself tells them: its browser, recordings and files, each with what it takes. They are this server's own tools too, with a session_id; where they are not listed here, call one with sessions.call.",
  inputSchema: {
    type: "object",
    properties: { [SESSION_ID]: { type: "string", description: "The session to ask." } },
    required: [SESSION_ID],
  },
  annotations: { readOnlyHint: true },
});

const SESSION_CALL = new McpSchema.Tool({
  name: "sessions.call",
  description: "Call a tool of a running session, as sessions.tools lists them.",
  inputSchema: {
    type: "object",
    properties: {
      [SESSION_ID]: { type: "string", description: "The session to act in." },
      name: { type: "string", description: "The tool's name." },
      arguments: { type: "object", description: "What the tool takes." },
    },
    required: [SESSION_ID, "name"],
  },
});

/**
 * The control plane as an MCP server: its own tools, and those of every session the
 * caller reaches, each sent on to the session it names.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const accounts = yield* Accounts;
    const settings = yield* Settings;
    const tools = yield* SessionTools;
    // The server is made of the routes the middleware below stands before, so the
    // middleware is handed it once it is there.
    const made = yield* Deferred.make<McpServer.McpServer["Service"]>();
    const forwarded = new Map<string, McpSchema.Tool>();

    /** The session a call names, and what is left for the session's own tool. */
    const named = (payload: unknown) => {
      const { [SESSION_ID]: sessionId, ...rest } = Predicate.isReadonlyObject(payload)
        ? payload
        : {};
      return typeof sessionId === "string" && sessionId !== ""
        ? Effect.succeed({ sessionId, rest })
        : Effect.fail(new McpSchema.InvalidParams({ message: `${SESSION_ID} names no session` }));
    };

    /** Sends a call on to the session it names, as whoever calls. */
    const forward = Effect.fn("Mcp.forward")(function* (name: string, payload: unknown) {
      const { sessionId, rest } = yield* named(payload);
      return yield* Effect.flatMap(calling("sessions:write"), (caller) =>
        tools.call(caller, sessionId, name, rest),
      ).pipe(Effect.catch((error) => Effect.succeed(refusal(error))));
    });

    /** Takes into the server the tools sessions were found to have since it last looked. */
    const follow = Effect.fn("Mcp.follow")(function* () {
      const fresh = (yield* tools.known()).filter((tool) => forwarded.get(tool.name) !== tool);
      if (fresh.length === 0) {
        return;
      }
      const server = yield* Deferred.await(made);
      for (const tool of fresh) {
        yield* server.addTool({
          tool: forSession(tool),
          annotations: Context.empty(),
          handle: (payload) => forward(tool.name, payload),
        });
        forwarded.set(tool.name, tool);
      }
    });

    // An app that runs in a browser is a page of any origin, and calls with a token it
    // was given. What a browser sends by itself, a person's cookies, is taken from the
    // pages of this program alone: a page of anywhere else would act as whoever looks at
    // it, so its request is read as if it carried none.
    const open = anyOrigin(EXPOSED);
    const admitted = HttpRouter.middleware((handled) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const origin = request.headers["origin"];
        const own = origin === undefined || origin === originOf(settings, request);
        const caller = yield* Effect.result(
          callerOf(
            accounts,
            own ? request : request.modify({ headers: Headers.remove(request.headers, "cookie") }),
          ),
        );
        if (caller._tag === "Failure") {
          return HttpServerResponse.jsonUnsafe(caller.failure, {
            status: UNAUTHORIZED,
            // Where a client that has no token learns how it gets one.
            headers: {
              "www-authenticate": `Bearer resource_metadata="${originOf(settings, request)}${RESOURCE_METADATA_PATH}${PATH}"`,
            },
          });
        }
        yield* follow();
        // Which origins may call is decided above, and the server below would refuse
        // every one it is not told by name: it is not told where the request is from.
        return yield* handled.pipe(
          Effect.provideService(CurrentCaller, caller.success),
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            request.modify({ headers: Headers.remove(request.headers, "origin") }),
          ),
        );
      }).pipe(open),
    ).layer;

    // What sessions have is known once one that runs was asked, and a client may have
    // listed the tools before that: these two ask the session itself, whenever.
    const generic = Layer.effectDiscard(
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        yield* server.addTool({
          tool: SESSION_TOOLS,
          annotations: Context.empty(),
          handle: Effect.fn("Mcp.sessionTools")(function* (payload: unknown) {
            const { sessionId } = yield* named(payload);
            return yield* Effect.flatMap(calling("sessions:write"), (caller) =>
              tools.of(caller, sessionId),
            ).pipe(
              Effect.map(
                (listed) =>
                  new McpSchema.CallToolResult({
                    content: [{ type: "text", text: JSON.stringify(listed) }],
                  }),
              ),
              Effect.catch((error) => Effect.succeed(refusal(error))),
            );
          }),
        });
        yield* server.addTool({
          tool: SESSION_CALL,
          annotations: Context.empty(),
          handle: Effect.fn("Mcp.sessionCall")(function* (payload: unknown) {
            const { sessionId, rest } = yield* named(payload);
            if (typeof rest["name"] !== "string") {
              return yield* new McpSchema.InvalidParams({ message: "name names no tool" });
            }
            const args = Predicate.isReadonlyObject(rest["arguments"]) ? rest["arguments"] : {};
            return yield* forward(rest["name"], { ...args, [SESSION_ID]: sessionId });
          }),
        });
        yield* Deferred.succeed(made, server);
      }),
    );

    return Layer.mergeAll(
      McpServer.toolkit(ControlTools).pipe(Layer.provide(handlers)),
      generic,
    ).pipe(
      Layer.provide(
        McpServer.layerHttp({
          name: "aperture",
          version: "0.0.0",
          instructions: INSTRUCTIONS,
          path: PATH,
          protocols: [
            McpProtocol.v2025_11_25,
            McpProtocol.v2025_06_18,
            McpProtocol.v2025_03_26,
            McpProtocol.v2024_11_05,
          ],
        }).pipe(Layer.provide(admitted)),
      ),
    );
  }),
);
