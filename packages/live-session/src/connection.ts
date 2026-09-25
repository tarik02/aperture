import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  resolveTenantHeader,
  type ApiCredentials,
  type IceServer,
} from "@aperture-browser/api-client";
import {
  decodeServerMessage,
  LIVE_SESSION_PROTOCOL,
  RasterFrameHeader,
  strictParseOptions,
  type LiveSessionCommandResult,
  type LiveSessionRasterFrame,
  type LiveSessionServerMessage,
  type LiveSessionSnapshot,
} from "./protocol.ts";

/** A live session operation that could not complete. */
export class LiveSessionError extends Data.TaggedError("LiveSessionError")<{
  readonly message: string;
}> {}

interface SessionIdentity {
  clientId: string;
  resumeSecret: string;
}

interface SessionHelloIdentity {
  name: string;
  avatarHash: string;
}

export type LiveSessionTransportKind = "webrtc" | "websocket";

interface LiveSessionConnectionCallbacks {
  onPhase: (phase: "connecting" | "connected" | "disconnected" | "error") => void;
  onMessage: (message: LiveSessionServerMessage) => void;
  onFrame: (frame: LiveSessionRasterFrame | null) => void;
  onStream: (stream: MediaStream | null) => void;
  onTransport: (transport: LiveSessionTransportKind | null) => void;
  onError: (message: string) => void;
}

interface LiveSessionConnectionOptions {
  /** The Aperture instance to connect to; defaults to the page's own origin. */
  baseUrl?: string;
  sessionId: string;
  credentials: ApiCredentials;
  sessionToken?: string;
  identity: SessionHelloIdentity;
  iceServers: readonly IceServer[];
  webrtcSupported: boolean;
  callbacks: LiveSessionConnectionCallbacks;
}

export interface LiveSessionConnection {
  /** Replaces the current session transport with a fresh one. */
  readonly reconnect: Effect.Effect<void>;
  /** Switches presentation to the given transport once it is ready. */
  readonly selectTransport: (
    kind: LiveSessionTransportKind,
  ) => Effect.Effect<void, LiveSessionError>;
  readonly sendReliable: (message: Record<string, unknown>) => boolean;
  readonly sendRealtime: (message: Record<string, unknown>) => boolean;
  /** Sends a command and waits for its result message. */
  readonly command: (
    type: string,
    payload?: Record<string, unknown>,
  ) => Effect.Effect<LiveSessionCommandResult, LiveSessionError>;
}

interface TransportRequest {
  kind: LiveSessionTransportKind;
  deferred: Deferred.Deferred<void, LiveSessionError>;
}

/** Forks a background effect into the connection's scope. */
type Fork = (effect: Effect.Effect<void>) => Fiber.Fiber<void>;

interface TransportCallbacks {
  hello: () => Record<string, unknown>;
  message: (transport: SessionTransport, message: LiveSessionServerMessage) => void;
  ready: (transport: SessionTransport) => void;
  failed: (transport: SessionTransport, error: LiveSessionError) => void;
  frame: (transport: SessionTransport, frame: LiveSessionRasterFrame) => void;
}

interface SessionTransport {
  readonly kind: LiveSessionTransportKind;
  sendReliable(message: Record<string, unknown>): boolean;
  sendRealtime(message: Record<string, unknown>): boolean;
  close(): void;
}

const SignalResponse = Schema.Union([
  Schema.Struct({ version: Schema.Literal(1), type: Schema.Literal("answer"), sdp: Schema.String }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("ice-candidate"),
    candidate: Schema.Struct({
      candidate: Schema.String,
      sdpMid: Schema.optionalKey(Schema.NullOr(Schema.String)),
      sdpMLineIndex: Schema.optionalKey(Schema.NullOr(Schema.Number.check(Schema.isInt()))),
      usernameFragment: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("error"),
    error: Schema.Struct({ code: Schema.String, message: Schema.String }),
  }),
]);

const decodeSignalResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(SignalResponse),
  strictParseOptions,
);

const decodeRasterFrameHeader = Schema.decodeUnknownOption(
  Schema.fromJsonString(RasterFrameHeader),
  strictParseOptions,
);

const WEBRTC_DEADLINE_MS = 5_000;
const WEBSOCKET_RETRY_MS = 500;
const WEBRTC_RETRY_MAX_MS = 15_000;

/**
 * Opens a live session connection. It prefers WebRTC presentation, falls back to
 * WebSocket raster frames, and keeps retrying WebRTC in the background. Closing the scope
 * closes every transport and fails pending commands.
 */
export const make = Effect.fnUntraced(function* (options: LiveSessionConnectionOptions) {
  const { callbacks } = options;
  const runFork = yield* FiberSet.makeRuntime<never, void, never>();
  const fork: Fork = (effect) => runFork(effect);
  const after = (millis: number, f: () => void) =>
    fork(Effect.sleep(millis).pipe(Effect.andThen(Effect.sync(f))));

  let active: SessionTransport | null = null;
  let candidate: SessionTransport | null = null;
  let identity: SessionIdentity | null = null;
  let preferredTransport: LiveSessionTransportKind = options.webrtcSupported
    ? "webrtc"
    : "websocket";
  let transportRequest: TransportRequest | null = null;
  let disposed = false;
  let retryTimer: Fiber.Fiber<void> | null = null;
  let webrtcRetryMs = 1_000;
  let nextRequestId = 0;
  let realtimeCounter = 0;
  let inboundRealtimeCounter = 0;
  let candidateMessages: LiveSessionServerMessage[] = [];
  let candidateFrame: LiveSessionRasterFrame | null = null;
  const pendingCommands = new Map<
    string,
    Deferred.Deferred<LiveSessionCommandResult, LiveSessionError>
  >();

  const hello = () => ({ type: "session.hello", ...(identity ?? options.identity) });

  const transportCallbacks: TransportCallbacks = {
    hello,
    message: (transport, message) => handleMessage(transport, message),
    ready: (transport) => activate(transport),
    failed: (transport, error) => transportFailed(transport, error),
    frame: (transport, frame) => {
      if (active === transport) {
        callbacks.onFrame(frame);
      } else if (candidate === transport) {
        candidateFrame = frame;
      }
    },
  };

  const dropCandidate = () => {
    candidate?.close();
    candidate = null;
    candidateMessages = [];
    candidateFrame = null;
  };

  const clearRetry = () => {
    retryTimer?.interruptUnsafe();
    retryTimer = null;
  };

  const rejectPending = (message: string) => {
    const error = new LiveSessionError({ message });
    for (const deferred of pendingCommands.values()) {
      Deferred.doneUnsafe(deferred, Effect.fail(error));
    }
    pendingCommands.clear();
  };

  const rejectTransportRequest = (message: string) => {
    if (!transportRequest) {
      return;
    }
    const request = transportRequest;
    transportRequest = null;
    Deferred.doneUnsafe(request.deferred, Effect.fail(new LiveSessionError({ message })));
  };

  const startPreferredTransport = () => {
    if (preferredTransport === "webrtc" && options.webrtcSupported) {
      startWebRTC();
    } else {
      startWebSocket();
    }
  };

  const startWebRTC = () => {
    if (disposed || candidate) {
      return;
    }
    let transport: WebRTCSessionTransport;
    try {
      transport = new WebRTCSessionTransport({
        baseUrl: options.baseUrl,
        sessionId: options.sessionId,
        credentials: options.credentials,
        sessionToken: options.sessionToken,
        iceServers: options.iceServers,
        callbacks: transportCallbacks,
        fork,
      });
    } catch (cause) {
      candidateFailed("webrtc", setupError(cause, "WebRTC setup failed"));
      return;
    }
    candidate = transport;
    candidateMessages = [];
    candidateFrame = null;
    transport.connect();
    after(WEBRTC_DEADLINE_MS, () => {
      if (candidate !== transport) {
        return;
      }
      dropCandidate();
      candidateFailed("webrtc", new LiveSessionError({ message: "WebRTC presentation timed out" }));
    });
  };

  const startWebSocket = () => {
    if (disposed || candidate) {
      return;
    }
    let transport: WebSocketSessionTransport;
    try {
      transport = new WebSocketSessionTransport({
        baseUrl: options.baseUrl,
        sessionId: options.sessionId,
        credentials: options.credentials,
        sessionToken: options.sessionToken,
        callbacks: transportCallbacks,
        fork,
      });
    } catch (cause) {
      candidateFailed("websocket", setupError(cause, "WebSocket setup failed"));
      return;
    }
    candidate = transport;
    candidateMessages = [];
    candidateFrame = null;
    transport.connect();
  };

  const startWebSocketLater = (millis: number) =>
    after(millis, () => {
      if (!disposed && active === null && candidate === null) {
        startWebSocket();
      }
    });

  const activate = (transport: SessionTransport) => {
    if (disposed || candidate !== transport) {
      transport.close();
      return;
    }
    const previous = active;
    const messages = candidateMessages;
    const frame = candidateFrame;
    if (previous && previous !== transport) {
      rejectPending("live session transport replaced");
    }
    candidate = null;
    candidateMessages = [];
    candidateFrame = null;
    active = transport;
    realtimeCounter = 0;
    inboundRealtimeCounter = 0;
    webrtcRetryMs = 1_000;
    callbacks.onPhase("connected");
    callbacks.onTransport(transport.kind);
    if (transportRequest?.kind === transport.kind) {
      const request = transportRequest;
      transportRequest = null;
      Deferred.doneUnsafe(request.deferred, Effect.void);
    }
    if (transport instanceof WebRTCSessionTransport) {
      callbacks.onFrame(null);
      callbacks.onStream(transport.mediaStream());
    } else {
      callbacks.onStream(null);
      if (frame) {
        callbacks.onFrame(frame);
      }
    }
    for (const message of messages) {
      deliverMessage(message);
    }
    if (
      transport.kind === "websocket" &&
      preferredTransport === "webrtc" &&
      options.webrtcSupported
    ) {
      scheduleWebRTCRetry();
    }
    if (previous && previous !== transport) {
      previous.close();
    }
  };

  const transportFailed = (transport: SessionTransport, error: LiveSessionError) => {
    if (disposed) {
      return;
    }
    if (candidate === transport) {
      dropCandidate();
      candidateFailed(transport.kind, error);
      return;
    }
    if (active !== transport) {
      return;
    }
    active = null;
    transport.close();
    rejectPending("live session transport was lost");
    callbacks.onPhase("disconnected");
    callbacks.onError(error.message);
    callbacks.onFrame(null);
    callbacks.onStream(null);
    callbacks.onTransport(null);
    startWebSocketLater(transport.kind === "webrtc" ? 0 : WEBSOCKET_RETRY_MS);
  };

  const handleMessage = (transport: SessionTransport, message: LiveSessionServerMessage) => {
    if (
      message.type === "error" &&
      message.code === "resume_rejected" &&
      candidate === transport &&
      active === null
    ) {
      identity = null;
    }
    if (message.type === "session.snapshot") {
      identity = { clientId: message.clientId, resumeSecret: message.resumeSecret };
    }
    if (active !== transport) {
      if (candidate !== transport) {
        return;
      }
      candidateMessages.push(message);
      if (message.type === "session.snapshot" && transport.kind === "websocket") {
        activate(transport);
      }
      return;
    }
    deliverMessage(message);
  };

  const deliverMessage = (message: LiveSessionServerMessage) => {
    if ("realtimeCounter" in message && message.realtimeCounter !== undefined) {
      if (message.realtimeCounter <= inboundRealtimeCounter) {
        return;
      }
      inboundRealtimeCounter = message.realtimeCounter;
    }
    if ("requestId" in message) {
      const deferred = pendingCommands.get(message.requestId);
      if (deferred) {
        pendingCommands.delete(message.requestId);
        Deferred.doneUnsafe(
          deferred,
          message.ok
            ? Effect.succeed(message)
            : Effect.fail(
                new LiveSessionError({
                  message: message.message ?? "live session command failed",
                }),
              ),
        );
      }
    }
    callbacks.onMessage(message);
  };

  const scheduleWebRTCRetry = () => {
    if (
      disposed ||
      preferredTransport !== "webrtc" ||
      !options.webrtcSupported ||
      active?.kind === "webrtc" ||
      retryTimer !== null
    ) {
      return;
    }
    const delay = webrtcRetryMs;
    webrtcRetryMs = Math.min(WEBRTC_RETRY_MAX_MS, webrtcRetryMs * 2);
    retryTimer = after(delay, () => {
      retryTimer = null;
      startWebRTC();
    });
  };

  const candidateFailed = (kind: LiveSessionTransportKind, error: LiveSessionError) => {
    const requested = transportRequest?.kind === kind;
    if (requested) {
      rejectTransportRequest(error.message);
      if (active) {
        preferredTransport = active.kind;
      }
    }
    if (active) {
      if (active.kind === "websocket") {
        scheduleWebRTCRetry();
      }
      return;
    }
    if (kind === "webrtc") {
      startWebSocket();
      return;
    }
    callbacks.onPhase("disconnected");
    callbacks.onError(error.message);
    startWebSocketLater(WEBSOCKET_RETRY_MS);
  };

  const sendReliable = (message: Record<string, unknown>) => active?.sendReliable(message) ?? false;

  const sendRealtime = (message: Record<string, unknown>) => {
    realtimeCounter += 1;
    return active?.sendRealtime({ realtimeCounter, ...message }) ?? false;
  };

  const close = () => {
    disposed = true;
    clearRetry();
    dropCandidate();
    active?.close();
    active = null;
    rejectTransportRequest("live session connection closed");
    rejectPending("live session connection closed");
    callbacks.onFrame(null);
    callbacks.onStream(null);
    callbacks.onTransport(null);
  };

  yield* Effect.addFinalizer(() => Effect.sync(close));

  callbacks.onPhase("connecting");
  startPreferredTransport();

  return {
    reconnect: Effect.sync(() => {
      clearRetry();
      dropCandidate();
      active?.close();
      active = null;
      rejectTransportRequest("live session transport replaced");
      rejectPending("live session transport replaced");
      callbacks.onPhase("connecting");
      startPreferredTransport();
    }),

    selectTransport: (kind) =>
      Effect.suspend(() => {
        if (kind === "webrtc" && !options.webrtcSupported) {
          return Effect.fail(
            new LiveSessionError({ message: "WebRTC presentation is unavailable" }),
          );
        }
        preferredTransport = kind;
        clearRetry();
        if (candidate && candidate.kind !== kind) {
          dropCandidate();
        }
        rejectTransportRequest("presentation selection was replaced");
        if (active?.kind === kind) {
          return Effect.void;
        }
        const deferred = Deferred.makeUnsafe<void, LiveSessionError>();
        transportRequest = { kind, deferred };
        if (candidate === null) {
          if (kind === "webrtc") {
            startWebRTC();
          } else {
            startWebSocket();
          }
        }
        return Deferred.await(deferred);
      }),

    sendReliable,
    sendRealtime,

    command: (type, payload = {}) =>
      Effect.suspend(() => {
        nextRequestId += 1;
        const requestId = `request-${nextRequestId}`;
        const deferred = Deferred.makeUnsafe<LiveSessionCommandResult, LiveSessionError>();
        pendingCommands.set(requestId, deferred);
        if (!sendReliable({ type, requestId, ...payload })) {
          pendingCommands.delete(requestId);
          return Effect.fail(
            new LiveSessionError({ message: "live session transport is unavailable" }),
          );
        }
        return Deferred.await(deferred).pipe(
          Effect.onInterrupt(() => Effect.sync(() => pendingCommands.delete(requestId))),
        );
      }),
  } satisfies LiveSessionConnection;
});

function setupError(cause: unknown, fallback: string) {
  return new LiveSessionError({
    message: cause instanceof Error && cause.message ? cause.message : fallback,
  });
}

class WebSocketSessionTransport implements SessionTransport {
  readonly kind = "websocket" as const;
  private readonly socket: WebSocket;
  private readonly callbacks: TransportCallbacks;
  private readonly fork: Fork;
  private readonly pendingRealtime = new Map<unknown, Record<string, unknown>>();
  private pendingRasterPacket: Blob | null = null;
  private rasterDecoder: Fiber.Fiber<void> | null = null;
  private decodingRaster = false;
  private realtimeFrame: number | null = null;
  private closed = false;

  constructor(options: {
    baseUrl: string | undefined;
    sessionId: string;
    credentials: ApiCredentials;
    sessionToken?: string;
    callbacks: TransportCallbacks;
    fork: Fork;
  }) {
    this.callbacks = options.callbacks;
    this.fork = options.fork;
    this.socket = new WebSocket(
      sessionWebSocketURL(options.baseUrl, options.sessionId),
      sessionProtocols(options.credentials, options.sessionToken),
    );
    this.socket.binaryType = "blob";
  }

  connect() {
    this.socket.addEventListener("open", () => {
      this.sendReliable(this.callbacks.hello());
    });
    this.socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        const message = decodeServerMessage(event.data);
        if (Option.isSome(message)) {
          this.callbacks.message(this, message.value);
        }
        return;
      }
      if (event.data instanceof Blob) {
        // Only the newest packet matters; older ones still waiting are dropped.
        this.pendingRasterPacket = event.data;
        if (!this.decodingRaster) {
          this.decodingRaster = true;
          this.rasterDecoder = this.fork(this.decodeRasterPackets());
        }
      }
    });
    this.socket.addEventListener("close", () => {
      if (!this.closed) {
        this.callbacks.failed(
          this,
          new LiveSessionError({ message: "WebSocket session transport closed" }),
        );
      }
    });
    this.socket.addEventListener("error", () => {
      if (!this.closed) {
        this.callbacks.failed(
          this,
          new LiveSessionError({ message: "WebSocket session transport failed" }),
        );
      }
    });
  }

  sendReliable(message: Record<string, unknown>) {
    this.flushRealtime();
    return this.sendNow(message);
  }

  sendRealtime(message: Record<string, unknown>) {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.pendingRealtime.delete(message.type);
    this.pendingRealtime.set(message.type, message);
    if (this.realtimeFrame === null) {
      this.realtimeFrame = window.requestAnimationFrame(() => {
        this.realtimeFrame = null;
        this.flushRealtime();
      });
    }
    return true;
  }

  close() {
    this.closed = true;
    this.pendingRasterPacket = null;
    this.rasterDecoder?.interruptUnsafe();
    this.rasterDecoder = null;
    if (this.realtimeFrame !== null) {
      window.cancelAnimationFrame(this.realtimeFrame);
      this.realtimeFrame = null;
    }
    this.pendingRealtime.clear();
    this.socket.close();
  }

  // Decodes one packet at a time until none is waiting.
  private decodeRasterPackets(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      while (true) {
        const packet = this.pendingRasterPacket;
        if (packet === null || this.closed) {
          this.decodingRaster = false;
          return;
        }
        this.pendingRasterPacket = null;
        const frame = yield* decodeRasterFrame(packet);
        if (Option.isSome(frame) && !this.closed) {
          this.callbacks.frame(this, frame.value);
        }
      }
    });
  }

  private flushRealtime() {
    if (this.realtimeFrame !== null) {
      window.cancelAnimationFrame(this.realtimeFrame);
      this.realtimeFrame = null;
    }
    for (const message of this.pendingRealtime.values()) {
      this.sendNow(message);
    }
    this.pendingRealtime.clear();
  }

  private sendNow(message: Record<string, unknown>) {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.socket.send(JSON.stringify(message));
    return true;
  }
}

class WebRTCSessionTransport implements SessionTransport {
  readonly kind = "webrtc" as const;
  private readonly connection: RTCPeerConnection;
  private readonly reliable: RTCDataChannel;
  private readonly realtime: RTCDataChannel;
  private readonly signal: WebSocket;
  private readonly callbacks: TransportCallbacks;
  private readonly fork: Fork;
  private readonly pendingCandidates: RTCIceCandidateInit[] = [];
  private reliableOpen = false;
  private realtimeOpen = false;
  private helloSent = false;
  private snapshotReceived = false;
  private stream: MediaStream | null = null;
  private streamReady = false;
  private closed = false;

  constructor(options: {
    baseUrl: string | undefined;
    sessionId: string;
    credentials: ApiCredentials;
    sessionToken?: string;
    iceServers: readonly IceServer[];
    callbacks: TransportCallbacks;
    fork: Fork;
  }) {
    this.callbacks = options.callbacks;
    this.fork = options.fork;
    this.connection = new RTCPeerConnection({
      iceServers: options.iceServers.map((server) => ({ ...server, urls: [...server.urls] })),
    });
    this.reliable = this.connection.createDataChannel("application", { ordered: true });
    this.realtime = this.connection.createDataChannel("application-realtime", {
      ordered: false,
      maxRetransmits: 0,
    });
    this.connection.addTransceiver("video", { direction: "recvonly" });
    this.signal = new WebSocket(
      signalWebSocketURL(options.baseUrl, options.sessionId),
      sessionProtocols(options.credentials, options.sessionToken),
    );
  }

  connect() {
    this.reliable.addEventListener("open", () => {
      this.reliableOpen = true;
      this.sendHello();
    });
    this.realtime.addEventListener("open", () => {
      this.realtimeOpen = true;
      this.sendHello();
    });
    this.reliable.addEventListener("message", (event) => this.handleApplicationMessage(event));
    this.realtime.addEventListener("message", (event) => this.handleApplicationMessage(event));
    for (const channel of [this.reliable, this.realtime]) {
      channel.addEventListener("close", () => this.fail("WebRTC session channel closed"));
      channel.addEventListener("error", () => this.fail("WebRTC session channel failed"));
    }
    this.connection.addEventListener("track", (event) => {
      this.stream = event.streams[0] ?? new MediaStream([event.track]);
      const ready = () => {
        if (!this.stream) {
          return;
        }
        this.streamReady = true;
        this.maybeReady();
      };
      if (event.track.muted) {
        event.track.addEventListener("unmute", ready, { once: true });
      } else {
        ready();
      }
    });
    this.connection.addEventListener("icecandidate", (event) => {
      if (event.candidate && this.signal.readyState === WebSocket.OPEN) {
        this.signal.send(
          JSON.stringify({
            version: 1,
            type: "ice-candidate",
            candidate: event.candidate.toJSON(),
          }),
        );
      }
    });
    this.connection.addEventListener("connectionstatechange", () => {
      if (
        this.connection.connectionState === "failed" ||
        this.connection.connectionState === "closed"
      ) {
        this.fail(`WebRTC ${this.connection.connectionState}`);
      }
    });
    this.signal.addEventListener("open", () => {
      this.fork(
        this.sendOffer().pipe(
          Effect.catchTag("LiveSessionError", (error) =>
            Effect.sync(() => this.fail(error.message)),
          ),
        ),
      );
    });
    this.signal.addEventListener("message", (event) => this.handleSignal(event));
    this.signal.addEventListener("close", () => this.fail("WebRTC signaling closed"));
    this.signal.addEventListener("error", () => this.fail("WebRTC signaling failed"));
  }

  sendReliable(message: Record<string, unknown>) {
    if (this.reliable.readyState !== "open") {
      return false;
    }
    this.reliable.send(JSON.stringify(message));
    return true;
  }

  sendRealtime(message: Record<string, unknown>) {
    if (this.realtime.readyState !== "open") {
      return false;
    }
    this.realtime.send(JSON.stringify(message));
    return true;
  }

  close() {
    this.closed = true;
    this.reliable.close();
    this.realtime.close();
    this.connection.close();
    this.signal.close();
  }

  mediaStream() {
    return this.stream;
  }

  private sendHello() {
    if (this.helloSent || !this.reliableOpen || !this.realtimeOpen) {
      return;
    }
    this.helloSent = this.sendReliable(this.callbacks.hello());
  }

  private handleApplicationMessage(event: MessageEvent<unknown>) {
    if (typeof event.data !== "string") {
      return;
    }
    const message = decodeServerMessage(event.data);
    if (Option.isNone(message)) {
      this.fail("WebRTC session message is invalid");
      return;
    }
    this.callbacks.message(this, message.value);
    if (message.value.type === "session.snapshot") {
      this.snapshotReceived = true;
      this.maybeReady();
    }
  }

  private handleSignal(event: MessageEvent<unknown>) {
    const decoded =
      typeof event.data === "string" ? decodeSignalResponse(event.data) : Option.none();
    if (Option.isNone(decoded)) {
      this.fail("WebRTC signaling message is invalid");
      return;
    }
    const signal = decoded.value;
    if (signal.type === "error") {
      this.fail(signal.error.message);
      return;
    }
    if (signal.type === "answer") {
      this.fork(
        Effect.tryPromise(() =>
          this.connection.setRemoteDescription({ type: "answer", sdp: signal.sdp }),
        ).pipe(
          // Candidates that arrived before the answer apply once it is set.
          Effect.andThen(
            Effect.suspend(() =>
              Effect.forEach(
                this.pendingCandidates.splice(0),
                (candidate) => Effect.tryPromise(() => this.connection.addIceCandidate(candidate)),
                { discard: true },
              ),
            ),
          ),
          Effect.catch(() => Effect.sync(() => this.fail("WebRTC answer is invalid"))),
        ),
      );
      return;
    }
    if (!this.connection.remoteDescription) {
      this.pendingCandidates.push(signal.candidate);
      return;
    }
    this.fork(
      Effect.tryPromise(() => this.connection.addIceCandidate(signal.candidate)).pipe(
        Effect.catch(() => Effect.sync(() => this.fail("WebRTC ICE candidate is invalid"))),
      ),
    );
  }

  private sendOffer(): Effect.Effect<void, LiveSessionError> {
    return Effect.gen({ self: this }, function* () {
      const negotiationFailed = (cause: unknown) => setupError(cause, "WebRTC negotiation failed");
      const offer = yield* Effect.tryPromise({
        try: () => this.connection.createOffer(),
        catch: negotiationFailed,
      });
      yield* Effect.tryPromise({
        try: () => this.connection.setLocalDescription(offer),
        catch: negotiationFailed,
      });
      const sdp = this.connection.localDescription?.sdp;
      if (!sdp) {
        return yield* new LiveSessionError({ message: "WebRTC offer is unavailable" });
      }
      this.signal.send(JSON.stringify({ version: 1, type: "offer", sdp }));
    });
  }

  private maybeReady() {
    if (this.snapshotReceived && this.stream && this.streamReady) {
      this.callbacks.ready(this);
    }
  }

  private fail(message: string) {
    if (!this.closed) {
      this.callbacks.failed(this, new LiveSessionError({ message }));
    }
  }
}

// A raster packet is a 4-byte header length, a JSON header, and the JPEG image. Malformed
// or unreadable packets decode to None.
function decodeRasterFrame(packet: Blob): Effect.Effect<Option.Option<LiveSessionRasterFrame>> {
  return Effect.gen(function* () {
    if (packet.size < 4) {
      return Option.none();
    }
    const prefix = yield* Effect.tryPromise(() => packet.slice(0, 4).arrayBuffer());
    const headerLength = new DataView(prefix).getUint32(0);
    if (headerLength === 0 || headerLength > packet.size - 4) {
      return Option.none();
    }
    const header = decodeRasterFrameHeader(
      yield* Effect.tryPromise(() => packet.slice(4, 4 + headerLength).text()),
    );
    return Option.map(header, (value) => ({
      targetId: value.targetId,
      data: packet.slice(4 + headerLength, packet.size, "image/jpeg"),
      width: value.width,
      height: value.height,
    }));
  }).pipe(Effect.orElseSucceed(() => Option.none()));
}

function sessionWebSocketURL(baseUrl: string | undefined, sessionId: string) {
  return webSocketURL(baseUrl, `/sessions/${encodeURIComponent(sessionId)}/session`);
}

function signalWebSocketURL(baseUrl: string | undefined, sessionId: string) {
  return webSocketURL(baseUrl, `/sessions/${encodeURIComponent(sessionId)}/webrtc/signal`);
}

function webSocketURL(baseUrl: string | undefined, path: string) {
  const url = new URL(path, baseUrl ?? window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function sessionProtocols(credentials: ApiCredentials, sessionToken?: string) {
  const protocols = [LIVE_SESSION_PROTOCOL];
  if (sessionToken) {
    protocols.push(`authorization.bearer.${sessionToken}`);
  } else if (credentials.kind === "bearer") {
    protocols.push(`authorization.bearer.${credentials.token}`);
  }
  const tenantId = resolveTenantHeader(credentials, "tenant-scoped");
  if (tenantId) {
    protocols.push(`x-aperture-tenant-id.${tenantId}`);
  }
  return protocols;
}

export type { LiveSessionConnectionCallbacks, LiveSessionConnectionOptions, LiveSessionSnapshot };
