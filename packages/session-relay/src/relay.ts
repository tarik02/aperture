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

type RelayRoute = "browser/status" | "session" | "webrtc/signal";
const routes: readonly RelayRoute[] = ["browser/status", "session", "webrtc/signal"];

/** Statuses the browser treats as final: it stops retrying until reconnected explicitly. */
type TerminalStatus = 401 | 403 | 404 | 410;
const isTerminalStatus = (status: number): status is TerminalStatus =>
  status === 401 || status === 403 || status === 404 || status === 410;

/** Registers only status, session WebSocket, and signaling; the consumer owns login. */
export function sessionRelay<R>(options: SessionRelayOptions<R>) {
  const publicOrigin = new URL(options.publicOrigin).origin;
  const upstream = parseUpstream(options.apertureBaseUrl);
  if (!options.prefix.startsWith("/") || /[?#]/.test(options.prefix)) {
    throw new Error("relay prefix must be an absolute path");
  }
  const prefix = options.prefix.replace(/\/$/, "");

  const upstreamURL = (sessionId: string, route: RelayRoute) => {
    const url = new URL(upstream);
    url.pathname = `${upstream.pathname.replace(/\/$/, "")}/sessions/${encodeURIComponent(sessionId)}/${route}`;
    return url;
  };

  const handle = (
    route: RelayRoute,
    http: HttpClient.HttpClient,
    makeSocket: Socket.WebSocketConstructor["Service"],
  ) => {
    const websocket = route !== "browser/status";
    return Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      // Browsers always send Origin on WebSocket upgrades, but may omit it on same-origin GETs.
      const origin = request.headers.origin;
      if (origin !== publicOrigin && (websocket || origin !== undefined)) {
        return relayError(403, "origin_denied", "Request origin is not allowed");
      }
      if (websocket && request.headers["sec-websocket-protocol"] !== protocol) {
        return relayError(400, "invalid_protocol", "Session subprotocol is required");
      }

      const { sessionId } = yield* HttpRouter.schemaPathParams(pathParams);
      const grant = yield* options.authorize(request, sessionId);
      const capability = Redacted.value(grant.capability);
      if (!capability.startsWith("ape_") && !capability.startsWith("apv_")) {
        return relayError(
          500,
          "invalid_relay_grant",
          "Relay requires an editor or viewer capability",
        );
      }
      if (grant.signal.aborted) return yield* rejectAccess(request, websocket, 403);

      // Check upstream authorization before upgrading: browser WebSockets cannot expose HTTP status.
      const response = yield* http
        .get(upstreamURL(grant.sessionId, "browser/status").toString(), {
          headers: { Authorization: `Bearer ${capability}` },
        })
        .pipe(
          Effect.timeout("15 seconds"),
          Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        );
      if (isTerminalStatus(response.status)) {
        return yield* rejectAccess(request, websocket, response.status);
      }
      if (response.status !== 200) {
        const status = response.status >= 400 ? response.status : 502;
        return relayError(status, "session_unavailable", "Upstream session is unavailable");
      }
      const statusBody = yield* response.arrayBuffer.pipe(Effect.timeout("15 seconds"));
      if (grant.signal.aborted) return yield* rejectAccess(request, websocket, 403);

      if (!websocket) {
        return HttpServerResponse.uint8Array(new Uint8Array(statusBody), {
          contentType: "application/json",
          headers: { "cache-control": "no-store" },
        });
      }
      const url = upstreamURL(grant.sessionId, route);
      url.protocol = upstream.protocol === "https:" ? "wss:" : "ws:";
      yield* relaySocket(request, url, capability, grant.signal).pipe(
        Effect.provideService(Socket.WebSocketConstructor, makeSocket),
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
          Effect.succeed(relayError(504, "upstream_timeout", "Aperture did not respond in time")),
        HttpClientError: () =>
          Effect.succeed(relayError(502, "upstream_unavailable", "Aperture is unavailable")),
      }),
      Effect.scoped,
    );
  };

  return HttpRouter.use(
    Effect.fn("sessionRelay.routes")(function* (router) {
      const http = yield* HttpClient.HttpClient;
      const makeSocket = yield* Socket.WebSocketConstructor;
      const prefixed = router.prefixed(prefix);
      for (const route of routes) {
        yield* prefixed.add(
          "GET",
          `/sessions/:sessionId/${route}`,
          handle(route, http, makeSocket),
        );
      }
    }),
  );
}

function parseUpstream(apertureBaseUrl: string): URL {
  const upstream = new URL(apertureBaseUrl);
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
  return upstream;
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
  status: TerminalStatus,
) {
  const denied = status === 401 || status === 403;
  if (!websocket) {
    return denied
      ? relayError(status, "access_denied", "Session access denied")
      : relayError(status, "session_unavailable", "Session unavailable");
  }
  const socket = yield* request.upgrade;
  // Acquiring the reader installs the close listeners before sending a close frame.
  yield* socket.reader;
  const writer = yield* socket.writer;
  yield* writer.write(
    new Socket.CloseEvent(4000 + status, denied ? "Session access denied" : "Session unavailable"),
  );
  return HttpServerResponse.empty();
});

/** Upgrades the browser request and pipes it to Aperture until either side closes or access is revoked. */
const relaySocket = Effect.fn("sessionRelay.relaySocket")(function* (
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
  capability: string,
  signal: AbortSignal,
) {
  const downstream = yield* request.upgrade;
  const writer = yield* downstream.writer;
  const upstream = yield* Socket.makeWebSocket(url.toString(), {
    protocols: [protocol, `authorization.bearer.${capability}`],
    openTimeout: "10 seconds",
    highWaterMark: 1024 * 1024,
  });

  const closeRevoked = Effect.gen(function* () {
    yield* revoked(signal);
    yield* writer.write(new Socket.CloseEvent(4403, "Session access revoked"));
  });

  yield* bridge(downstream, upstream).pipe(
    Effect.raceFirst(closeRevoked),
    Effect.catchTag("SocketError", (error) => {
      // Only clean closes pass through; anything else tells the browser to retry.
      const { reason } = error;
      const code =
        reason._tag === "SocketCloseError" && (reason.code === 1000 || reason.code === 1001)
          ? reason.code
          : 1011;
      return writer
        .write(new Socket.CloseEvent(code, "Session transport closed"))
        .pipe(Effect.catchTag("SocketError", () => Effect.void));
    }),
  );
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
