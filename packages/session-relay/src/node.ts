import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeSocket from "@effect/platform-node/NodeSocket";

// Effect removes its "error" listener before closing a released socket. The ws package then
// emits "error" for a socket closed while still connecting (a viewer leaving before Aperture
// answers), and an EventEmitter error without a listener crashes the process.
const webSocketConstructor = Layer.effect(
  Socket.WebSocketConstructor,
  Effect.gen(function* () {
    const make = yield* Socket.WebSocketConstructor;
    const runFork = Effect.runForkWith(yield* Effect.context<never>());

    return (url, options) => {
      const socket = make(url, options);
      socket.addEventListener("error", () => {
        runFork(
          Effect.logWarning("Session relay upstream socket error").pipe(
            Effect.annotateLogs({ url }),
          ),
        );
      });
      return socket;
    };
  }),
).pipe(Layer.provide(NodeSocket.layerWebSocketConstructorWS));

/** Supply to sessionRelay in a Node HttpRouter application. Does not start a server. */
export const nodeRelayLayer = Layer.mergeAll(NodeHttpClient.layerNodeHttp, webSocketConstructor);
