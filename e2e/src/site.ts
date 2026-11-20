// The one module of Node's own here: `NodeHttpServer` serves on a server it is handed.
// oxlint-disable-next-line import/no-nodejs-modules
import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export interface Site {
  readonly url: string;
  readonly port: number;
  /** The paths it was asked for, in order. */
  readonly asked: () => readonly string[];
}

/** What a site answers a request with; the request is `HttpServerRequest`. */
export type Answer<E = never> = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  HttpServerRequest
>;

/**
 * A site on this machine for a session's browser to visit, for as long as the scope lasts.
 * The session has to be let reach it: `--egress-allow 127.0.0.1`.
 */
export const serve = Effect.fn("Site.serve")(function* <E>(answer: Answer<E>, host = "127.0.0.1") {
  const asked: string[] = [];
  const node = createServer();
  const server = yield* NodeHttpServer.make(() => node, { port: 0, host });
  yield* server.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      asked.push(request.url);
      return yield* answer;
    }),
  );
  // A site ends with its scope, whatever a browser still has open to it: an answer that
  // halts on its way would otherwise be waited for.
  yield* Effect.addFinalizer(() => Effect.sync(() => node.closeAllConnections()));
  const port = server.address._tag === "UnixPathAddress" ? 0 : server.address.port;
  return { url: `http://${host}:${port}`, port, asked: () => asked } satisfies Site;
});

/** A page that is this HTML. */
export const html = (body: string): Answer =>
  Effect.succeed(HttpServerResponse.text(body, { contentType: "text/html; charset=utf-8" }));

/** An answer that goes by what was asked. */
export const by = <E>(answer: (request: HttpServerRequest) => Answer<E>): Answer<E> =>
  Effect.gen(function* () {
    return yield* answer(yield* HttpServerRequest);
  });
