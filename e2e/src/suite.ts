import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { layer } from "@effect/vitest";
import * as Layer from "effect/Layer";

/**
 * What the checks and what they stand on reach this machine through: its files, its
 * programs, HTTP and WebSockets.
 */
export const platform = Layer.mergeAll(
  NodeServices.layer,
  NodeHttpClient.layerUndici,
  NodeSocket.layerWebSocketConstructor,
);

export type Platform = Layer.Success<typeof platform>;

/**
 * Checks that share what `needs` gives: a session, a node, a watching browser. Its checks
 * run one after another, each on what the ones before it left, and on the real clock:
 * what they wait for takes real time.
 */
export const suite = <R, E>(needs: Layer.Layer<R, E, Platform>) =>
  layer(Layer.provideMerge(needs, platform), { excludeTestServices: true, timeout: "3 minutes" });
