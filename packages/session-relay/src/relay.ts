import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Socket from "effect/unstable/socket/Socket";

const protocol = "aperture-session.v1";
const pathParams = Schema.Struct({
  sessionId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]+$/)),
});

export class RelayDenied extends Schema.TaggedError<RelayDenied>()("RelayDenied", {
  status: Schema.Literals([401, 403]),
}) {}

/** A consumer-authorized connection. Aborting the signal revokes active access. */
export interface RelayGrant {
  readonly sessionId: string;
  /** An editor (ape_) or viewer (apv_) capability, never an owner or account token. */
  readonly capability: Redacted.Redacted<string>;
  readonly signal: AbortSignal;
}

export interface SessionRelayOptions<R = never> {
  readonly prefix: string;
  readonly publicOrigin: string;
  readonly apertureBaseUrl: string;
  readonly authorize: (
    request: HttpServerRequest.HttpServerRequest,
    sessionId: string,
  ) => Effect.Effect<RelayGrant, RelayDenied, R>;
}

/** Registers only status, session WebSocket, and signaling; the consumer owns login. */
export function sessionRelay<R>(options: SessionRelayOptions<R>) {
  const publicOrigin = new URL(options.publicOrigin).origin;
  const upstream = new URL(options.apertureBaseUrl);
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
    throw new Error("apertureBaseUrl must use HTTP or HTTPS");
  }
  if (
    upstream.username !== "" ||
    upstream.password !== "" ||
    upstream.search !== "" ||
    upstream.hash !== ""
  ) {
    throw new Error("apertureBaseUrl must not contain credentials, a query, or a fragment");
  }
  if (!options.prefix.startsWith("/") || /[?#]/.test(options.prefix)) {
    throw new Error("relay prefix must be an absolute path");
  }
  const prefix = options.prefix.replace(/\/$/, "");

  return HttpRouter.use(
    Effect.fn("sessionRelay.routes")(function* (router) {
      const routes = router.prefixed(prefix);
      const http = yield* HttpClient.HttpClient;
      const makeSocket = yield* Socket.WebSocketConstructor;

      for (const route of ["browser/status", "session", "webrtc/signal"] as const) {
        const websocket = route !== "browser/status";
        yield* routes.add(
          "GET",
          `/sessions/:sessionId/${route}`,
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const origin = request.headers.origin;
            if (
              (websocket && origin !== publicOrigin) ||
              (origin !== undefined && origin !== publicOrigin)
            ) {
              return relayError(403, "origin_denied", "Request origin is not allowed");
            }
            if (websocket && request.headers["sec-websocket-protocol"] !== protocol) {
              return relayError(400, "invalid_protocol", "Session subprotocol is required");
            }
            const params = yield* HttpRouter.schemaPathParams(pathParams);
            const grant = yield* options.authorize(request, params.sessionId);
            const capability = Redacted.value(grant.capability);
            if (!capability.startsWith("ape_") && !capability.startsWith("apv_")) {
              return relayError(
                500,
                "invalid_relay_grant",
                "Relay requires an editor or viewer capability",
              );
            }
            if (grant.signal.aborted) {
              return yield* rejectAccess(request, websocket, 403);
            }
            const url = new URL(upstream);
            const sessionBase = `${upstream.pathname.replace(/\/$/, "")}/sessions/${encodeURIComponent(grant.sessionId)}`;
            // Check upstream authorization before upgrading: browser WebSockets cannot expose HTTP status.
            url.pathname = `${sessionBase}/browser/status`;
            const response = yield* http
              .get(url.toString(), {
                headers: { Authorization: `Bearer ${capability}` },
              })
              .pipe(
                Effect.timeout("15 seconds"),
                Effect.provideService(HttpClient.TracerPropagationEnabled, false),
              );
            if (response.status === 401 || response.status === 403) {
              return yield* rejectAccess(request, websocket, response.status);
            }
            if (response.status === 404 || response.status === 410) {
              return yield* rejectAccess(request, websocket, response.status);
            }
            if (response.status !== 200) {
              return relayError(
                response.status >= 400 ? response.status : 502,
                "session_unavailable",
                "Upstream session is unavailable",
              );
            }
            const body = yield* response.arrayBuffer.pipe(Effect.timeout("15 seconds"));
            if (grant.signal.aborted) {
              return yield* rejectAccess(request, websocket, 403);
            }
            if (!websocket) {
              return HttpServerResponse.uint8Array(new Uint8Array(body), {
                contentType: "application/json",
                headers: { "cache-control": "no-store" },
              });
            }
            const downstream = yield* request.upgrade;
            const writer = yield* downstream.writer;
            url.pathname = `${sessionBase}/${route}`;
            url.protocol = upstream.protocol === "https:" ? "wss:" : "ws:";
            const remote = yield* Socket.makeWebSocket(url.toString(), {
              protocols: [protocol, `authorization.bearer.${capability}`],
              openTimeout: "10 seconds",
              highWaterMark: 1024 * 1024,
            }).pipe(Effect.provideService(Socket.WebSocketConstructor, makeSocket));
            yield* bridge(downstream, remote).pipe(
              Effect.raceFirst(
                Effect.gen(function* () {
                  yield* revoked(grant.signal);
                  yield* writer.write(new Socket.CloseEvent(4403, "Session access revoked"));
                }),
              ),
              Effect.catchTag("SocketError", (error) => {
                const reason = error.reason;
                const code =
                  reason._tag === "SocketCloseError" &&
                  (reason.code === 1000 || reason.code === 1001)
                    ? reason.code
                    : 1011;
                return writer
                  .write(new Socket.CloseEvent(code, "Session transport closed"))
                  .pipe(Effect.catchTag("SocketError", () => Effect.void));
              }),
            );
            return HttpServerResponse.empty();
          }).pipe(
            Effect.catchTags({
              RelayDenied: (error) =>
                Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
                  rejectAccess(request, websocket, error.status),
                ),
              SchemaError: () =>
                Effect.succeed(relayError(400, "invalid_session", "Invalid session identifier")),
              TimeoutError: () =>
                Effect.succeed(
                  relayError(504, "upstream_timeout", "Aperture did not respond in time"),
                ),
              HttpClientError: () =>
                Effect.succeed(relayError(502, "upstream_unavailable", "Aperture is unavailable")),
            }),
            Effect.scoped,
          ),
        );
      }
    }),
  );
}

function relayError(status: number, code: string, message: string) {
  return HttpServerResponse.jsonUnsafe(
    { error: { code, message } },
    { status, headers: { "cache-control": "no-store" } },
  );
}

const rejectAccess = Effect.fn("sessionRelay.rejectAccess")(function* (
  request: HttpServerRequest.HttpServerRequest,
  websocket: boolean,
  status: 401 | 403 | 404 | 410,
) {
  if (websocket) {
    const socket = yield* request.upgrade;
    // Acquiring the reader installs the close listeners before sending a close frame.
    yield* socket.reader;
    const writer = yield* socket.writer;
    yield* writer.write(
      new Socket.CloseEvent(
        4000 + status,
        status === 401 || status === 403 ? "Session access denied" : "Session unavailable",
      ),
    );
    return HttpServerResponse.empty();
  }
  return status === 401 || status === 403
    ? relayError(status, "access_denied", "Session access denied")
    : relayError(status, "session_unavailable", "Session unavailable");
});

const bridge = Effect.fn("sessionRelay.bridge")(function* (
  downstream: Socket.Socket,
  upstream: Socket.Socket,
) {
  const [client, server] = yield* Effect.all([downstream.reader, upstream.reader], {
    concurrency: "unbounded",
  });
  const [toClient, toServer] = yield* Effect.all([downstream.writer, upstream.writer]);
  yield* Effect.raceFirst(
    client.pull.pipe(Effect.flatMap(toServer.writeAll), Effect.forever),
    server.pull.pipe(Effect.flatMap(toClient.writeAll), Effect.forever),
  );
});

/** AbortSignal is the consumer's per-user/per-session revocation boundary. */
const revoked = (signal: AbortSignal): Effect.Effect<void> =>
  Effect.callback((resume) => {
    if (signal.aborted) {
      resume(Effect.void);
      return;
    }
    const abort = () => resume(Effect.void);
    signal.addEventListener("abort", abort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", abort));
  });
