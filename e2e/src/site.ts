import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as Effect from "effect/Effect";

export interface Site {
  readonly url: string;
  /** The paths it was asked for, in order. */
  readonly asked: () => readonly string[];
}

/**
 * A site on this machine for a session's browser to visit, for as long as the scope lasts.
 * The session has to be let reach it: `--egress-allow 127.0.0.1`.
 */
export const serve = (answer: (request: IncomingMessage, response: ServerResponse) => void) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ site: Site; close: () => void }>((listening) => {
          const asked: string[] = [];
          const server = createServer((request, response) => {
            asked.push(request.url ?? "");
            answer(request, response);
          });
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address !== null ? address.port : 0;
            listening({
              site: { url: `http://127.0.0.1:${port}`, asked: () => asked },
              close: () => server.close(),
            });
          });
        }),
    ),
    ({ close }) => Effect.sync(close),
  ).pipe(Effect.map(({ site }) => site));

/** A page that is this HTML. */
export const html = (body: string) => (_: IncomingMessage, response: ServerResponse) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(body);
};
