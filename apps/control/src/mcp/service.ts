import type { Caller } from "@aperture-browser/control-api";
import type * as McpSchema from "effect/ai/McpSchema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { Forbidden } from "../errors.ts";
import type { NodeError } from "../sessions/service.ts";

/** What asking a session's own server for something may come to. */
export type SessionToolError = Forbidden | NodeError;

/**
 * The tools of sessions' own MCP servers: the browser, recordings, files. A call goes to
 * the session it names, which does it.
 */
export interface SessionToolsShape {
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
