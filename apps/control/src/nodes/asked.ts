import type { ExecutorError } from "@aperture-browser/executor-client";
import * as Effect from "effect/Effect";
import { NodeRefused, NodeUnreachable } from "../errors.ts";
import type { Node } from "./schemas.ts";

/** Codes that say the node was not there to answer, and not that it answered no. */
const NOT_THERE: ReadonlySet<string> = new Set(["unavailable", "deadline_exceeded", "unknown"]);

/** What a node's executor was asked, with its failing told as the control plane tells it. */
export const asked =
  (node: Node) =>
  <A, R>(call: Effect.Effect<A, ExecutorError, R>) =>
    Effect.mapError(call, (error) =>
      NOT_THERE.has(error.code)
        ? new NodeUnreachable({ node: node.name, message: error.message })
        : new NodeRefused({ node: node.name, code: error.code, message: error.message }),
    );
