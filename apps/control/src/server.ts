// The one module of Node's own here: `NodeHttpServer` serves on a server it is handed.
// oxlint-disable-next-line import/no-nodejs-modules
import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";

/** An HTTP server that listens there; on a port of the system's choosing for port 0. */
export const listen = (address: { readonly host: string; readonly port: number }) =>
  NodeHttpServer.layer(createServer, address);
