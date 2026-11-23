import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { afterEach, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Failures from "./failures.ts";

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
 * what they wait for takes real time. Of a check that fails, what its programs logged and
 * its pages showed is kept, while they are still there to tell.
 */
export const suite = <R, E>(needs: Layer.Layer<R, E, Platform>) => {
  const within = layer(Layer.provideMerge(needs, platform), {
    excludeTestServices: true,
    timeout: "3 minutes",
  });
  return (name: string, checks: Parameters<typeof within>[1]) =>
    within(name, (it) => {
      afterEach(async ({ task }) => {
        if (task.result?.state !== "fail") {
          return;
        }
        const kept = await Effect.runPromise(
          Failures.keep(task.file.name, task.name).pipe(
            Effect.provide(NodeServices.layer),
            Effect.catchCause(() => Effect.succeed(undefined)),
          ),
        );
        if (kept !== undefined) {
          console.log(`what is known of the check that failed is kept in ${kept}`);
        }
      });
      checks(it);
    });
};
