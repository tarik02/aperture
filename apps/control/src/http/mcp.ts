import { covers, CurrentCaller, type Scope } from "@aperture-browser/control-api";
import * as McpProtocol from "effect/ai/McpProtocol";
import * as McpSchema from "effect/ai/McpSchema";
import * as McpServer from "effect/ai/McpServer";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { Accounts } from "../accounts/service.ts";
import { Forbidden, SettingInvalid } from "../errors.ts";
import { SessionTools, type SessionToolError } from "../mcp/service.ts";
import sessionTools from "../mcp/gen/session-tools.json" with { type: "json" };
import { ControlTools } from "../mcp/toolkit.ts";
import { Policy, type Target } from "../policy/service.ts";
import { Sessions } from "../sessions/service.ts";
import { Settings } from "../settings/service.ts";
import { Shares } from "../shares/service.ts";
import { Snapshots } from "../snapshots/service.ts";
import { fullVersion } from "../version.ts";
import { type Joined, Workspaces } from "../workspaces/service.ts";
import { actorOf, Doer } from "../events/doer.ts";
import { Events } from "../events/service.ts";
import { callerOf } from "./caller.ts";
import { doing } from "./doer.ts";
import {
  sessionsAsked,
  settingScopes,
  shareUrl,
  snapshotsAsked,
  telling,
  ticketScope,
} from "./handlers.ts";
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

Create a session with sessions.create, or find one with sessions.list. The browser, recording and file tools act in the session named by their session_id; sessions.tools lists what a session has, and sessions.call calls a tool of it by name. A session created from a snapshot starts with that snapshot's profile: signed in where it was. To let a person see a session or act in it, give them the url of sessions.ticket, or of shares.create for someone with no account. To get a recording, a screenshot or a download out of a session, list its files with the files tool and fetch one at the url of sessions.file_link. Suspend a session you are done with for now, and delete one nobody needs. account.get tells what this token is for.`;

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

/** Who calls a tool, whatever their token is for. */
const anyone = Effect.serviceOption(CurrentCaller).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () => Effect.die("a tool was called by nobody"),
      onSome: Effect.succeed,
    }),
  ),
);

/** The level a settings tool names, with what it names it by. */
const settingTarget = (where: {
  readonly level: Target["level"];
  readonly workspace_id?: string | undefined;
  readonly session_id?: string | undefined;
}): Effect.Effect<Target, SettingInvalid> => {
  switch (where.level) {
    case "instance":
      return Effect.succeed({ level: "instance" });
    case "account":
      return Effect.succeed({ level: "account", workspaceId: where.workspace_id ?? null });
    case "workspace":
      return where.workspace_id === undefined
        ? Effect.fail(
            new SettingInvalid({ key: "", message: "a workspace is named by its workspace_id" }),
          )
        : Effect.succeed({ level: "workspace", id: where.workspace_id });
    case "session":
      return where.session_id === undefined
        ? Effect.fail(
            new SettingInvalid({ key: "", message: "a session is named by its session_id" }),
          )
        : Effect.succeed({ level: "session", id: where.session_id });
  }
};

const handlers = ControlTools.toLayer(
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const snapshots = yield* Snapshots;
    const shares = yield* Shares;
    const workspaces = yield* Workspaces;
    const events = yield* Events;
    const settings = yield* Settings;
    const policy = yield* Policy;
    const tell = yield* telling;
    /** Where the request that calls came to, for the addresses a tool tells. */
    const origin = Effect.serviceOption(HttpServerRequest.HttpServerRequest).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.die("a tool was called by no request"),
          onSome: (request) => Effect.succeed(originOf(settings, request)),
        }),
      ),
    );
    const shown = ({ workspace, role }: Joined) => ({ ...workspace, role });
    return {
      "sessions.list": ({ workspace_id, state, label, tag }) =>
        calling("sessions:read").pipe(
          Effect.flatMap(sessions.list),
          Effect.map((all) =>
            all.filter(sessionsAsked({ workspaceId: workspace_id, state, label, tag })),
          ),
          Effect.flatMap(tell.all),
          Effect.map((all) => ({ sessions: all })),
        ),
      "sessions.get": ({ session_id }) =>
        Effect.flatMap(calling("sessions:read"), (caller) => sessions.get(caller, session_id)).pipe(
          Effect.flatMap(tell.one),
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
            storageState: undefined,
          }),
        ).pipe(Effect.flatMap(tell.one)),
      "sessions.update": ({ session_id, label, tags }) =>
        Effect.flatMap(calling("sessions:write"), (caller) =>
          sessions.describe(caller, session_id, { label, tags }),
        ).pipe(Effect.flatMap(tell.one)),
      "sessions.suspend": ({ session_id }) =>
        Effect.flatMap(calling("sessions:write"), (caller) =>
          sessions.suspend(caller, session_id),
        ).pipe(Effect.flatMap(tell.one)),
      "sessions.resume": ({ session_id }) =>
        Effect.flatMap(calling("sessions:write"), (caller) =>
          sessions.resume(caller, session_id),
        ).pipe(Effect.flatMap(tell.one)),
      "sessions.delete": ({ session_id }) =>
        Effect.flatMap(calling("sessions:write"), (caller) =>
          sessions.delete(caller, session_id),
        ).pipe(Effect.as({ deleted: session_id })),
      "sessions.pin": ({ session_id, pinned }) =>
        Effect.flatMap(calling("sessions:write"), (caller) =>
          sessions.pin(caller, session_id, pinned),
        ).pipe(Effect.flatMap(tell.one)),
      "settings.get": Effect.fn(function* (asked) {
        const target = yield* settingTarget(asked);
        const [scope] = settingScopes(target);
        const caller = scope === null ? yield* anyone : yield* calling(scope);
        return { settings: yield* policy.views(caller, target) };
      }),
      "settings.set": Effect.fn(function* ({ key, value, min, max, allowed, ...where }) {
        const target = yield* settingTarget(where);
        const caller = yield* calling(settingScopes(target)[1]);
        return yield* policy.set(caller, target, key, {
          ...(value === undefined ? {} : { value }),
          ...(min === undefined ? {} : { min }),
          ...(max === undefined ? {} : { max }),
          ...(allowed === undefined ? {} : { allowed }),
        });
      }),
      "settings.clear": Effect.fn(function* ({ key, ...where }) {
        const target = yield* settingTarget(where);
        const caller = yield* calling(settingScopes(target)[1]);
        return yield* policy.clear(caller, target, key);
      }),
      "sessions.promote": (asked) =>
        Effect.flatMap(calling("snapshots:write"), (caller) =>
          snapshots.take(caller, asked.session_id, {
            name: asked.name,
            description: asked.description,
            tags: asked.tags,
            replaces: asked.replaces,
          }),
        ),
      "sessions.proxy": ({ session_id }) =>
        Effect.flatMap(calling("sessions:read"), (caller) =>
          sessions.proxy(caller, session_id),
        ).pipe(Effect.map((proxy) => ({ proxy }))),
      "sessions.set_proxy": ({ session_id, proxy }) =>
        Effect.flatMap(calling("sessions:write"), (caller) =>
          sessions.setProxy(caller, session_id, proxy),
        ).pipe(Effect.as({ proxy })),
      "sessions.ticket": Effect.fn(function* ({ session_id, name, access = {} }) {
        const caller = yield* calling(ticketScope(access));
        const admitted = yield* sessions.admit(caller, session_id, { name, access }, yield* origin);
        return {
          url: admitted.url,
          ticket: admitted.ticket,
          expires_at: DateTime.formatIso(admitted.expiresAt),
        };
      }),
      "sessions.file_link": Effect.fn(function* (asked) {
        const caller = yield* calling("sessions:write");
        return yield* sessions.fileLink(
          caller,
          asked.session_id,
          {
            path: asked.path,
            write: asked.write ?? false,
            lasts:
              asked.expires_in_seconds === undefined
                ? undefined
                : Duration.seconds(asked.expires_in_seconds),
          },
          yield* origin,
        );
      }),
      "shares.list": ({ session_id }) =>
        Effect.flatMap(calling("sessions:read"), (caller) => shares.list(caller, session_id)).pipe(
          Effect.map((all) => ({ shares: all })),
        ),
      "shares.create": Effect.fn(function* (asked) {
        const caller = yield* calling("sessions:write");
        const { share, secret } = yield* shares.create(caller, asked.session_id, {
          name: asked.name,
          role: asked.role,
          lasts:
            asked.expires_in_hours === undefined
              ? undefined
              : Duration.hours(asked.expires_in_hours),
        });
        return { ...share, url: shareUrl(yield* origin, share.id, secret) };
      }),
      "shares.revoke": ({ session_id, share_id }) =>
        Effect.flatMap(calling("sessions:write"), (caller) =>
          shares.revoke(caller, session_id, share_id),
        ).pipe(Effect.as({ revoked: share_id })),
      "snapshots.list": ({ workspace_id, name, tag }) =>
        calling("snapshots:read").pipe(
          Effect.flatMap(snapshots.list),
          Effect.map((all) => ({
            snapshots: all.filter(snapshotsAsked({ workspaceId: workspace_id, name, tag })),
          })),
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
      "workspaces.list": () =>
        anyone.pipe(
          Effect.flatMap(workspaces.list),
          Effect.map((all) => ({ workspaces: all.map(shown) })),
        ),
      "workspaces.members": ({ workspace_id }) =>
        Effect.flatMap(calling("workspaces:read"), (caller) =>
          workspaces.members(caller, workspace_id),
        ).pipe(Effect.map((members) => ({ members }))),
      "workspaces.create": ({ name }) =>
        Effect.flatMap(calling("workspaces:write"), (caller) =>
          workspaces.create(caller, name),
        ).pipe(Effect.map(shown)),
      "workspaces.rename": ({ workspace_id, name }) =>
        Effect.flatMap(calling("workspaces:write"), (caller) =>
          workspaces.rename(caller, workspace_id, name),
        ).pipe(Effect.map(shown)),
      "workspaces.delete": ({ workspace_id }) =>
        Effect.flatMap(calling("workspaces:write"), (caller) =>
          workspaces.delete(caller, workspace_id),
        ).pipe(Effect.as({ deleted: workspace_id })),
      "workspaces.admit": ({ workspace_id, account_id, role }) =>
        Effect.flatMap(calling("workspaces:write"), (caller) =>
          workspaces.admit(caller, workspace_id, account_id, role),
        ).pipe(Effect.as({ admitted: account_id, role })),
      "workspaces.dismiss": ({ workspace_id, account_id }) =>
        Effect.flatMap(calling("workspaces:write"), (caller) =>
          workspaces.dismiss(caller, workspace_id, account_id),
        ).pipe(Effect.as({ dismissed: account_id })),
      "account.get": Effect.fn(function* () {
        const caller = yield* anyone;
        if (Option.isNone(caller.account)) {
          return yield* new Forbidden({ message: "this token is of no account" });
        }
        return { ...caller.account.value, scopes: caller.scopes, resources: caller.resources };
      }),
      "events.list": Effect.fn(function* (asked) {
        const page = yield* events.list(yield* anyone, {
          kind: asked.kind,
          resourceKind: asked.resource_kind,
          resourceId: asked.resource_id,
          workspaceId: asked.workspace_id,
          since: asked.since === undefined ? undefined : DateTime.toDate(asked.since),
          cursor: asked.cursor,
          limit: asked.limit,
        });
        // Whose an event is, is what decides who reads it, and is told to nobody.
        return { ...page, events: page.events.map(({ ownerId: _, ...event }) => event) };
      }),
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
    "List the tools of a running session as the session itself tells them: its browser, recordings and files, each with what it takes. They are this server's own tools too, with a session_id; a session on a node of another version may have some that are not, which sessions.call calls.",
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
    // Every part of a release is of one version, so what a session of this build has is
    // what the sessions of the nodes this control plane drives have.
    const built = yield* Schema.decodeUnknownEffect(Schema.Array(McpSchema.Tool))(
      sessionTools,
    ).pipe(Effect.orDie);

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
        // Which origins may call is decided above, and the server below would refuse
        // every one it is not told by name: it is not told where the request is from.
        return yield* handled.pipe(
          Effect.provideService(CurrentCaller, caller.success),
          Effect.provideService(Doer, doing(settings, request, actorOf(caller.success))),
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            request.modify({ headers: Headers.remove(request.headers, "origin") }),
          ),
        );
      }).pipe(open),
    ).layer;

    const forwarded = Layer.effectDiscard(
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        for (const tool of built) {
          yield* server.addTool({
            tool: forSession(tool),
            annotations: Context.empty(),
            handle: (payload) => forward(tool.name, payload),
          });
        }
        // A node of another version may have tools this build has not, or have them
        // otherwise: these two ask the session itself.
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
      }),
    );

    return Layer.mergeAll(
      McpServer.toolkit(ControlTools).pipe(Layer.provide(handlers)),
      forwarded,
    ).pipe(
      Layer.provide(
        McpServer.layerHttp({
          name: "aperture",
          version: fullVersion(settings.commit),
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
