import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * What the console's pages load and run: what this program serves them, and nothing a
 * page writes into itself. Styles are written into elements by what draws the pages, and
 * a session is reached wherever its node says it is, which is not known here: pictures,
 * video and connections go anywhere, and what runs comes from here alone.
 */
const POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "media-src 'self' blob: https: http:",
  "connect-src 'self' https: http: wss: ws:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * How a browser is to take whatever this program answers with: as the kind it says and
 * no other, in no frame of anyone's, where consent to an app is one click on a page; and
 * telling nobody where it came from, as an address may carry what lets its holder in.
 */
export const layer = HttpRouter.middleware(
  (handled) =>
    Effect.map(
      handled,
      HttpServerResponse.setHeaders({
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "x-frame-options": "DENY",
        "content-security-policy": POLICY,
      }),
    ),
  { global: true },
);
