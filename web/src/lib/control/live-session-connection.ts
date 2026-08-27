import { z } from "zod";
import { resolveTenantHeader, type ApiCredentials } from "#/lib/api/client.ts";
import {
  LIVE_SESSION_PROTOCOL,
  liveSessionServerMessageSchema,
  rasterFrameSchema,
  type LiveSessionCommandResult,
  type CollaborationRole,
  type LiveSessionRasterFrame,
  type LiveSessionServerMessage,
  type LiveSessionSnapshot,
} from "#/lib/control/live-session-protocol.ts";

type SessionIdentity = {
  clientId: string;
  resumeSecret: string;
};

type SessionHelloIdentity = {
  name: string;
  avatarHash: string;
};

export type LiveSessionTransportKind = "webrtc" | "websocket";

type LiveSessionConnectionCallbacks = {
  onPhase: (phase: "connecting" | "connected" | "disconnected" | "error") => void;
  onMessage: (message: LiveSessionServerMessage) => void;
  onFrame: (frame: LiveSessionRasterFrame | null) => void;
  onStream: (stream: MediaStream | null) => void;
  onTransport: (transport: LiveSessionTransportKind | null) => void;
  onError: (message: string) => void;
};

type LiveSessionConnectionOptions = {
  sessionId: string;
  role: CollaborationRole;
  credentials: ApiCredentials;
  sessionToken?: string;
  identity: SessionHelloIdentity;
  iceServers: RTCIceServer[];
  webrtcSupported: boolean;
  callbacks: LiveSessionConnectionCallbacks;
};

const sessionIdentitySchema = z
  .object({
    clientId: z.string().uuid(),
    resumeSecret: z.string().min(1),
  })
  .strict();

const sessionIdentityCache = new Map<string, SessionIdentity>();

type PendingCommand = {
  resolve: (result: LiveSessionCommandResult) => void;
  reject: (error: Error) => void;
};

type TransportRequest = {
  kind: LiveSessionTransportKind;
  resolve: () => void;
  reject: (error: Error) => void;
};

type TransportCallbacks = {
  hello: () => Record<string, unknown>;
  message: (transport: SessionTransport, message: LiveSessionServerMessage) => void;
  ready: (transport: SessionTransport) => void;
  failed: (transport: SessionTransport, error: Error) => void;
  frame: (transport: SessionTransport, frame: LiveSessionRasterFrame) => void;
};

interface SessionTransport {
  readonly kind: LiveSessionTransportKind;
  sendReliable(message: Record<string, unknown>): boolean;
  sendRealtime(message: Record<string, unknown>): boolean;
  close(): void;
}

const signalResponseSchema = z.discriminatedUnion("type", [
  z.object({ version: z.literal(1), type: z.literal("answer"), sdp: z.string() }).strict(),
  z
    .object({
      version: z.literal(1),
      type: z.literal("ice-candidate"),
      candidate: z
        .object({
          candidate: z.string(),
          sdpMid: z.string().nullable().optional(),
          sdpMLineIndex: z.number().int().nullable().optional(),
          usernameFragment: z.string().nullable().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      type: z.literal("error"),
      error: z.object({ code: z.string(), message: z.string() }).strict(),
    })
    .strict(),
]);

const WEBRTC_DEADLINE_MS = 5_000;
const WEBSOCKET_RETRY_MS = 500;
const WEBRTC_RETRY_MAX_MS = 15_000;

export class LiveSessionConnection {
  private readonly options: LiveSessionConnectionOptions;
  private active: SessionTransport | null = null;
  private candidate: SessionTransport | null = null;
  private identity: SessionIdentity | null;
  private preferredTransport: LiveSessionTransportKind;
  private transportRequest: TransportRequest | null = null;
  private disposed = false;
  private retryTimer: number | null = null;
  private webrtcRetryMs = 1_000;
  private nextRequestId = 0;
  private realtimeCounter = 0;
  private inboundRealtimeCounter = 0;
  private candidateMessages: LiveSessionServerMessage[] = [];
  private candidateFrame: LiveSessionRasterFrame | null = null;
  private readonly pendingCommands = new Map<string, PendingCommand>();

  constructor(options: LiveSessionConnectionOptions) {
    this.options = options;
    this.identity = loadSessionIdentity(options.sessionId, options.role, options.identity);
    this.preferredTransport = options.webrtcSupported ? "webrtc" : "websocket";
  }

  connect() {
    this.disposed = false;
    this.options.callbacks.onPhase("connecting");
    this.startPreferredTransport();
  }

  close() {
    this.disposed = true;
    this.clearRetry();
    this.candidate?.close();
    this.candidate = null;
    this.candidateMessages = [];
    this.candidateFrame = null;
    this.active?.close();
    this.active = null;
    this.rejectTransportRequest("live session connection closed");
    this.rejectPending("live session connection closed");
    this.options.callbacks.onFrame(null);
    this.options.callbacks.onStream(null);
    this.options.callbacks.onTransport(null);
  }

  reconnect() {
    this.clearRetry();
    this.candidate?.close();
    this.candidate = null;
    this.candidateMessages = [];
    this.candidateFrame = null;
    this.active?.close();
    this.active = null;
    this.rejectTransportRequest("live session transport replaced");
    this.rejectPending("live session transport replaced");
    this.options.callbacks.onPhase("connecting");
    this.startPreferredTransport();
  }

  selectTransport(kind: LiveSessionTransportKind): Promise<void> {
    if (kind === "webrtc" && !this.options.webrtcSupported) {
      return Promise.reject(new Error("WebRTC presentation is unavailable"));
    }
    this.preferredTransport = kind;
    this.clearRetry();
    if (this.candidate && this.candidate.kind !== kind) {
      this.candidate.close();
      this.candidate = null;
      this.candidateMessages = [];
      this.candidateFrame = null;
    }
    this.rejectTransportRequest("presentation selection was replaced");
    if (this.active?.kind === kind) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.transportRequest = { kind, resolve, reject };
      if (this.candidate === null) {
        if (kind === "webrtc") {
          this.startWebRTC();
        } else {
          this.startWebSocket();
        }
      }
    });
  }

  sendReliable(message: Record<string, unknown>): boolean {
    return this.active?.sendReliable(message) ?? false;
  }

  sendRealtime(message: Record<string, unknown>): boolean {
    this.realtimeCounter += 1;
    return (
      this.active?.sendRealtime({
        realtimeCounter: this.realtimeCounter,
        ...message,
      }) ?? false
    );
  }

  command(type: string, payload: Record<string, unknown> = {}): Promise<LiveSessionCommandResult> {
    this.nextRequestId += 1;
    const requestId = `request-${this.nextRequestId}`;
    return new Promise((resolve, reject) => {
      this.pendingCommands.set(requestId, { resolve, reject });
      if (!this.sendReliable({ type, requestId, ...payload })) {
        this.pendingCommands.delete(requestId);
        reject(new Error("live session transport is unavailable"));
      }
    });
  }

  private hello() {
    return {
      type: "session.hello",
      ...(this.identity ?? this.options.identity),
    };
  }

  private transportCallbacks(): TransportCallbacks {
    return {
      hello: () => this.hello(),
      message: (transport, message) => this.handleMessage(transport, message),
      ready: (transport) => this.activate(transport),
      failed: (transport, error) => this.transportFailed(transport, error),
      frame: (transport, frame) => {
        if (this.active === transport) {
          this.options.callbacks.onFrame(frame);
        } else if (this.candidate === transport) {
          this.candidateFrame = frame;
        }
      },
    };
  }

  private startPreferredTransport() {
    if (this.preferredTransport === "webrtc" && this.options.webrtcSupported) {
      this.startWebRTC();
    } else {
      this.startWebSocket();
    }
  }

  private startWebRTC() {
    if (this.disposed || this.candidate) {
      return;
    }
    let transport: WebRTCSessionTransport;
    try {
      transport = new WebRTCSessionTransport({
        sessionId: this.options.sessionId,
        credentials: this.options.credentials,
        sessionToken: this.options.sessionToken,
        iceServers: this.options.iceServers,
        callbacks: this.transportCallbacks(),
      });
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error("WebRTC setup failed");
      this.candidateFailed("webrtc", error);
      return;
    }
    this.candidate = transport;
    this.candidateMessages = [];
    this.candidateFrame = null;
    transport.connect();
    window.setTimeout(() => {
      if (this.candidate !== transport) {
        return;
      }
      transport.close();
      this.candidate = null;
      this.candidateMessages = [];
      this.candidateFrame = null;
      this.candidateFailed("webrtc", new Error("WebRTC presentation timed out"));
    }, WEBRTC_DEADLINE_MS);
  }

  private startWebSocket() {
    if (this.disposed || this.candidate) {
      return;
    }
    let transport: WebSocketSessionTransport;
    try {
      transport = new WebSocketSessionTransport({
        sessionId: this.options.sessionId,
        credentials: this.options.credentials,
        sessionToken: this.options.sessionToken,
        callbacks: this.transportCallbacks(),
      });
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error("WebSocket setup failed");
      this.candidateFailed("websocket", error);
      return;
    }
    this.candidate = transport;
    this.candidateMessages = [];
    this.candidateFrame = null;
    transport.connect();
  }

  private activate(transport: SessionTransport) {
    if (this.disposed || this.candidate !== transport) {
      transport.close();
      return;
    }
    const previous = this.active;
    const messages = this.candidateMessages;
    const frame = this.candidateFrame;
    if (previous && previous !== transport) {
      this.rejectPending("live session transport replaced");
    }
    this.candidate = null;
    this.candidateMessages = [];
    this.candidateFrame = null;
    this.active = transport;
    this.realtimeCounter = 0;
    this.inboundRealtimeCounter = 0;
    this.webrtcRetryMs = 1_000;
    this.options.callbacks.onPhase("connected");
    this.options.callbacks.onTransport(transport.kind);
    if (this.transportRequest?.kind === transport.kind) {
      const request = this.transportRequest;
      this.transportRequest = null;
      request.resolve();
    }
    if (transport instanceof WebRTCSessionTransport) {
      this.options.callbacks.onFrame(null);
      this.options.callbacks.onStream(transport.mediaStream());
    } else {
      this.options.callbacks.onStream(null);
      if (frame) {
        this.options.callbacks.onFrame(frame);
      }
    }
    for (const message of messages) {
      this.deliverMessage(message);
    }
    if (
      transport.kind === "websocket" &&
      this.preferredTransport === "webrtc" &&
      this.options.webrtcSupported
    ) {
      this.scheduleWebRTCRetry();
    }
    if (previous && previous !== transport) {
      previous.close();
    }
  }

  private transportFailed(transport: SessionTransport, error: Error) {
    if (this.disposed) {
      return;
    }
    if (this.candidate === transport) {
      this.candidate = null;
      this.candidateMessages = [];
      this.candidateFrame = null;
      transport.close();
      this.candidateFailed(transport.kind, error);
      return;
    }
    if (this.active !== transport) {
      return;
    }
    this.active = null;
    transport.close();
    this.rejectPending("live session transport was lost");
    this.options.callbacks.onPhase("disconnected");
    this.options.callbacks.onError(error.message);
    this.options.callbacks.onFrame(null);
    this.options.callbacks.onStream(null);
    this.options.callbacks.onTransport(null);
    window.setTimeout(
      () => {
        if (!this.disposed && this.active === null && this.candidate === null) {
          this.startWebSocket();
        }
      },
      transport.kind === "webrtc" ? 0 : WEBSOCKET_RETRY_MS,
    );
  }

  private handleMessage(transport: SessionTransport, message: LiveSessionServerMessage) {
    if (
      message.type === "error" &&
      message.code === "resume_rejected" &&
      this.candidate === transport &&
      this.active === null
    ) {
      this.identity = null;
      clearSessionIdentity(this.options.sessionId, this.options.role, this.options.identity);
    }
    if (message.type === "session.snapshot") {
      this.identity = { clientId: message.clientId, resumeSecret: message.resumeSecret };
      storeSessionIdentity(
        this.options.sessionId,
        this.options.role,
        this.options.identity,
        this.identity,
      );
    }
    if (this.active !== transport) {
      if (this.candidate !== transport) {
        return;
      }
      this.candidateMessages.push(message);
      if (message.type === "session.snapshot" && transport.kind === "websocket") {
        this.activate(transport);
      }
      return;
    }
    this.deliverMessage(message);
  }

  private deliverMessage(message: LiveSessionServerMessage) {
    if ("realtimeCounter" in message && message.realtimeCounter !== undefined) {
      if (message.realtimeCounter <= this.inboundRealtimeCounter) {
        return;
      }
      this.inboundRealtimeCounter = message.realtimeCounter;
    }
    if ("requestId" in message) {
      const result = message;
      const pending = this.pendingCommands.get(result.requestId);
      if (pending) {
        this.pendingCommands.delete(result.requestId);
        if (result.ok) {
          pending.resolve(result);
        } else {
          pending.reject(new Error(result.message ?? "live session command failed"));
        }
      }
    }
    this.options.callbacks.onMessage(message);
  }

  private scheduleWebRTCRetry() {
    if (
      this.disposed ||
      this.preferredTransport !== "webrtc" ||
      !this.options.webrtcSupported ||
      this.active?.kind === "webrtc" ||
      this.retryTimer !== null
    ) {
      return;
    }
    const delay = this.webrtcRetryMs;
    this.webrtcRetryMs = Math.min(WEBRTC_RETRY_MAX_MS, this.webrtcRetryMs * 2);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.startWebRTC();
    }, delay);
  }

  private clearRetry() {
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private rejectPending(message: string) {
    for (const pending of this.pendingCommands.values()) {
      pending.reject(new Error(message));
    }
    this.pendingCommands.clear();
  }

  private rejectTransportRequest(message: string) {
    if (!this.transportRequest) {
      return;
    }
    const request = this.transportRequest;
    this.transportRequest = null;
    request.reject(new Error(message));
  }

  private candidateFailed(kind: LiveSessionTransportKind, error: Error) {
    const requested = this.transportRequest?.kind === kind;
    if (requested) {
      this.rejectTransportRequest(error.message);
      if (this.active) {
        this.preferredTransport = this.active.kind;
      }
    }
    if (this.active) {
      if (this.active.kind === "websocket") {
        this.scheduleWebRTCRetry();
      }
      return;
    }
    if (kind === "webrtc") {
      this.startWebSocket();
      return;
    }
    this.options.callbacks.onPhase("disconnected");
    this.options.callbacks.onError(error.message);
    window.setTimeout(() => {
      if (!this.disposed && this.active === null && this.candidate === null) {
        this.startWebSocket();
      }
    }, WEBSOCKET_RETRY_MS);
  }
}

class WebSocketSessionTransport implements SessionTransport {
  readonly kind = "websocket" as const;
  private readonly socket: WebSocket;
  private readonly callbacks: TransportCallbacks;
  private readonly pendingRealtime = new Map<unknown, Record<string, unknown>>();
  private pendingRasterPacket: Blob | null = null;
  private decodingRasterPacket = false;
  private realtimeFrame: number | null = null;
  private closed = false;

  constructor(options: {
    sessionId: string;
    credentials: ApiCredentials;
    sessionToken?: string;
    callbacks: TransportCallbacks;
  }) {
    this.callbacks = options.callbacks;
    this.socket = new WebSocket(
      sessionWebSocketURL(options.sessionId),
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
        if (message) {
          this.callbacks.message(this, message);
        }
        return;
      }
      if (event.data instanceof Blob) {
        this.pendingRasterPacket = event.data;
        void this.decodeRasterPacket();
      }
    });
    this.socket.addEventListener("close", () => {
      if (!this.closed) {
        this.callbacks.failed(this, new Error("WebSocket session transport closed"));
      }
    });
    this.socket.addEventListener("error", () => {
      if (!this.closed) {
        this.callbacks.failed(this, new Error("WebSocket session transport failed"));
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
    if (this.realtimeFrame !== null) {
      window.cancelAnimationFrame(this.realtimeFrame);
      this.realtimeFrame = null;
    }
    this.pendingRealtime.clear();
    this.socket.close();
  }

  private async decodeRasterPacket() {
    if (this.decodingRasterPacket || this.pendingRasterPacket === null) {
      return;
    }
    const packet = this.pendingRasterPacket;
    this.pendingRasterPacket = null;
    this.decodingRasterPacket = true;
    let frame: LiveSessionRasterFrame | null = null;
    try {
      frame = await decodeRasterFrame(packet);
    } catch {
      // Ignore malformed or unreadable binary packets.
    }
    this.decodingRasterPacket = false;
    if (this.closed) {
      return;
    }
    if (frame) {
      this.callbacks.frame(this, frame);
    }
    void this.decodeRasterPacket();
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
  private readonly pendingCandidates: RTCIceCandidateInit[] = [];
  private reliableOpen = false;
  private realtimeOpen = false;
  private helloSent = false;
  private snapshotReceived = false;
  private stream: MediaStream | null = null;
  private streamReady = false;
  private closed = false;

  constructor(options: {
    sessionId: string;
    credentials: ApiCredentials;
    sessionToken?: string;
    iceServers: RTCIceServer[];
    callbacks: TransportCallbacks;
  }) {
    this.callbacks = options.callbacks;
    this.connection = new RTCPeerConnection({ iceServers: options.iceServers });
    this.reliable = this.connection.createDataChannel("application", { ordered: true });
    this.realtime = this.connection.createDataChannel("application-realtime", {
      ordered: false,
      maxRetransmits: 0,
    });
    this.connection.addTransceiver("video", { direction: "recvonly" });
    this.signal = new WebSocket(
      signalWebSocketURL(options.sessionId),
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
      void this.connection
        .createOffer()
        .then((offer) => this.connection.setLocalDescription(offer))
        .then(() => {
          const description = this.connection.localDescription;
          if (!description?.sdp) {
            throw new Error("WebRTC offer is unavailable");
          }
          this.signal.send(JSON.stringify({ version: 1, type: "offer", sdp: description.sdp }));
        })
        .catch((cause: unknown) => {
          this.fail(cause instanceof Error ? cause.message : "WebRTC negotiation failed");
        });
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
    if (!message) {
      this.fail("WebRTC session message is invalid");
      return;
    }
    this.callbacks.message(this, message);
    if (message.type === "session.snapshot") {
      this.snapshotReceived = true;
      this.maybeReady();
    }
  }

  private handleSignal(event: MessageEvent<unknown>) {
    if (typeof event.data !== "string") {
      this.fail("WebRTC signaling message is invalid");
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(event.data);
    } catch {
      this.fail("WebRTC signaling message is invalid");
      return;
    }
    const parsed = signalResponseSchema.safeParse(value);
    if (!parsed.success) {
      this.fail("WebRTC signaling message is invalid");
      return;
    }
    if (parsed.data.type === "error") {
      this.fail(parsed.data.error.message);
      return;
    }
    if (parsed.data.type === "answer") {
      void this.connection
        .setRemoteDescription({ type: "answer", sdp: parsed.data.sdp })
        .then(async () => {
          for (const candidate of this.pendingCandidates.splice(0)) {
            await this.connection.addIceCandidate(candidate);
          }
        })
        .catch(() => this.fail("WebRTC answer is invalid"));
      return;
    }
    if (!this.connection.remoteDescription) {
      this.pendingCandidates.push(parsed.data.candidate);
      return;
    }
    void this.connection
      .addIceCandidate(parsed.data.candidate)
      .catch(() => this.fail("WebRTC ICE candidate is invalid"));
  }

  private maybeReady() {
    if (this.snapshotReceived && this.stream && this.streamReady) {
      this.callbacks.ready(this);
    }
  }

  mediaStream() {
    return this.stream;
  }

  private fail(message: string) {
    if (!this.closed) {
      this.callbacks.failed(this, new Error(message));
    }
  }
}

function decodeServerMessage(raw: string): LiveSessionServerMessage | null {
  try {
    const value: unknown = JSON.parse(raw);
    const parsed = liveSessionServerMessageSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function decodeRasterFrame(packet: Blob): Promise<LiveSessionRasterFrame | null> {
  if (packet.size < 4) {
    return null;
  }
  const headerLength = new DataView(await packet.slice(0, 4).arrayBuffer()).getUint32(0);
  if (headerLength === 0 || headerLength > packet.size - 4) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(await packet.slice(4, 4 + headerLength).text());
  } catch {
    return null;
  }
  const parsed = rasterFrameSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  return {
    targetId: parsed.data.targetId,
    data: packet.slice(4 + headerLength, packet.size, "image/jpeg"),
    width: parsed.data.width,
    height: parsed.data.height,
  };
}

function sessionWebSocketURL(sessionId: string) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/sessions/${encodeURIComponent(sessionId)}/session`;
}

function signalWebSocketURL(sessionId: string) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/sessions/${encodeURIComponent(sessionId)}/webrtc/signal`;
}

function sessionProtocols(credentials: ApiCredentials, sessionToken?: string) {
  const protocols = [LIVE_SESSION_PROTOCOL];
  if (sessionToken) {
    protocols.push(`authorization.bearer.${sessionToken}`);
  } else if (credentials.credentialType === "api_token") {
    protocols.push(`authorization.bearer.${credentials.token}`);
  }
  const tenantId = resolveTenantHeader(credentials, "tenant-scoped");
  if (tenantId) {
    protocols.push(`x-aperture-tenant-id.${tenantId}`);
  }
  return protocols;
}

function sessionIdentityStorageKey(
  sessionId: string,
  role: CollaborationRole,
  identity: SessionHelloIdentity,
) {
  return `aperture.live-session.resume:${sessionId}:${role}:${identity.avatarHash}:${encodeURIComponent(identity.name)}`;
}

function loadSessionIdentity(
  sessionId: string,
  role: CollaborationRole,
  identity: SessionHelloIdentity,
): SessionIdentity | null {
  const key = sessionIdentityStorageKey(sessionId, role, identity);
  const cached = sessionIdentityCache.get(key);
  if (cached) {
    return cached;
  }
  const navigation = window.performance.getEntriesByType("navigation").at(0);
  if (!(navigation instanceof PerformanceNavigationTiming) || navigation.type !== "reload") {
    return null;
  }
  try {
    const stored = window.sessionStorage.getItem(key);
    if (!stored) {
      return null;
    }
    const value: unknown = JSON.parse(stored);
    const parsed = sessionIdentitySchema.safeParse(value);
    if (!parsed.success) {
      window.sessionStorage.removeItem(key);
      return null;
    }
    sessionIdentityCache.set(key, parsed.data);
    return parsed.data;
  } catch {
    return null;
  }
}

function storeSessionIdentity(
  sessionId: string,
  role: CollaborationRole,
  helloIdentity: SessionHelloIdentity,
  identity: SessionIdentity,
) {
  const key = sessionIdentityStorageKey(sessionId, role, helloIdentity);
  sessionIdentityCache.set(key, identity);
  try {
    window.sessionStorage.setItem(key, JSON.stringify(identity));
  } catch {
    // The in-memory identity still covers transport handovers and route remounts.
  }
}

function clearSessionIdentity(
  sessionId: string,
  role: CollaborationRole,
  identity: SessionHelloIdentity,
) {
  const key = sessionIdentityStorageKey(sessionId, role, identity);
  sessionIdentityCache.delete(key);
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // The rejected identity is already absent from memory.
  }
}

export type { LiveSessionConnectionCallbacks, LiveSessionConnectionOptions, LiveSessionSnapshot };
