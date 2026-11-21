import type { Caller } from "@aperture-browser/control-api";
import type * as McpSchema from "effect/ai/McpSchema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { Forbidden } from "../errors.ts";
import type { NodeError } from "../sessions/service.ts";

/** What asking a session's own server for something may come to. */
export type SessionToolError = Forbidden | NodeError;

/**
 * The tools of sessions' own MCP servers: the browser, recordings, files. They are the
 * session's to say and to do, so nothing of them is written here: what they are is asked
 * of a session that runs, and a call goes to the session it names.
 */
export interface SessionToolsShape {
  /**
   * The tools sessions have, as far as a session told them: the nodes of one version have
   * the same, so each version is asked once, of whichever session runs on such a node.
   * None while no session of a version nobody asked yet runs.
   */
  readonly known: () => Effect.Effect<ReadonlyArray<McpSchema.Tool>>;
  /** The tools of the caller's session, as the session tells them now. */
  readonly of: (
    caller: Caller,
    sessionId: string,
  ) => Effect.Effect<ReadonlyArray<McpSchema.Tool>, SessionToolError>;
  /** Calls a tool of the caller's session, as the caller: with a ticket of theirs into it. */
  readonly call: (
    caller: Caller,
    sessionId: string,
    name: string,
    args: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<McpSchema.CallToolResult, SessionToolError>;
}

export class SessionTools extends Context.Service<SessionTools, SessionToolsShape>()(
  "@aperture-browser/control/SessionTools",
) {}
