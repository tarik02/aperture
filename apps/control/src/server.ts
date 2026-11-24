// The one module of Node's own here: `NodeHttpServer` serves on a server it is handed.
// oxlint-disable-next-line import/no-nodejs-modules
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";

const UNAVAILABLE = 503;

/**
 * How long a connection nothing is asked over is kept. A proxy before the control plane
 * keeps its connections to it for reuse, Traefik's for 90 seconds: one the control plane
 * closes first is closed as the proxy sends a request over it now and then, and the
 * proxy answers that request with 502. Node's own is 5 seconds.
 */
const KEPT_IDLE_MS = 120_000;

/**
 * A server that tells whoever asks before anything serves on it to ask again. It listens
 * from when it is made, which is before the database is there and the app with it, and
 * Node leaves a request nothing hears without an answer for as long as its caller waits.
 */
const answering = () => {
  const server = createServer({ keepAliveTimeout: KEPT_IDLE_MS });
  const notYet = (_request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(UNAVAILABLE, { "retry-after": "1", connection: "close" });
    response.end();
  };
  server.on("request", notYet);
  server.on("newListener", (event, listener) => {
    if (event === "request" && listener !== notYet) {
      server.off("request", notYet);
    }
  });
  return server;
};

/** An HTTP server that listens there; on a port of the system's choosing for port 0. */
export const listen = (address: { readonly host: string; readonly port: number }) =>
  NodeHttpServer.layer(answering, address);
