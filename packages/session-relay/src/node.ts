import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeSocket from "@effect/platform-node/NodeSocket";

/** Supply to sessionRelay in a Node HttpRouter application. Does not start a server. */
export const nodeRelayLayer = Layer.mergeAll(
  NodeHttpClient.layerNodeHttp,
  NodeSocket.layerWebSocketConstructorWS,
  Layer.succeed(HttpClient.TracerPropagationEnabled, false),
);
