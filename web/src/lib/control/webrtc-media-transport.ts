import {
  EMPTY,
  Observable,
  Subject,
  Subscription,
  animationFrameScheduler,
  auditTime,
  catchError,
  concat,
  concatMap,
  defer,
  distinctUntilChanged,
  exhaustMap,
  filter,
  finalize,
  from,
  fromEvent,
  ignoreElements,
  map,
  merge,
  mergeMap,
  of,
  retry,
  scan,
  share,
  shareReplay,
  startWith,
  switchMap,
  take,
  takeUntil,
  takeWhile,
  tap,
  throwError,
  timer,
  withLatestFrom,
} from "rxjs";
import { webSocket, type WebSocketSubject } from "rxjs/webSocket";
import { z } from "zod";
import type { ApiCredentials } from "#/lib/api/client.ts";
import type { ClientMessage } from "#/lib/control/messages.ts";

export type WebRTCMediaPhase = "idle" | "connecting" | "live" | "failed";

export type WebRTCMediaSize = {
  width: number;
  height: number;
  deviceScaleFactor: number;
  physicalWidth: number;
  physicalHeight: number;
};

export type WebRTCViewportRequest = {
  width: number;
  height: number;
  deviceScaleFactor: number;
};

export type WebRTCStreamSettings = {
  fps: number;
  bitrateKbps: number;
  keyframeInterval: number;
};

export type WebRTCMediaMetrics = {
  receivedBitrateKbps: number | null;
  decodedFps: number | null;
  frameWidth: number | null;
  frameHeight: number | null;
  framesDecoded: number | null;
  framesDropped: number | null;
  packetsLost: number | null;
  jitterMs: number | null;
  jitterBufferDelayMs: number | null;
  roundTripTimeMs: number | null;
  inputRttMs: number | null;
  codec: string | null;
  candidatePair: string | null;
};

export type WebRTCMediaFailure =
  | { kind: "setup-failed"; cause: unknown }
  | { kind: "signaling-invalid-message" }
  | { kind: "invalid-sdp-offer" }
  | { kind: "missing-local-answer" }
  | { kind: "invalid-ice-candidate" }
  | { kind: "negotiation-failed"; cause: unknown }
  | { kind: "peer-connection-lost"; state: RTCPeerConnectionState }
  | { kind: "ice-failed" }
  | { kind: "producer-failed"; code: string | null; detail: string | null }
  | { kind: "media-timeout"; progress: string }
  | { kind: "unexpected"; cause: unknown };

export type WebRTCMediaError =
  | WebRTCMediaFailure
  | { kind: "producer-resize-failed"; detail: string };

export function webRTCMediaErrorMessage(error: WebRTCMediaError): string {
  switch (error.kind) {
    case "setup-failed":
      return "WebRTC setup failed";
    case "signaling-invalid-message":
      return "WebRTC signaling message is invalid";
    case "invalid-sdp-offer":
      return "invalid WebRTC SDP offer";
    case "missing-local-answer":
      return "missing local WebRTC answer";
    case "invalid-ice-candidate":
      return "invalid WebRTC ICE candidate";
    case "negotiation-failed":
      return error.cause instanceof Error ? error.cause.message : "WebRTC negotiation failed";
    case "peer-connection-lost":
      return `WebRTC ${error.state}`;
    case "ice-failed":
      return "WebRTC ICE failed";
    case "producer-failed": {
      const detail = error.detail ?? error.code;
      return detail ? `WebRTC producer failed: ${detail}` : "WebRTC producer failed";
    }
    case "media-timeout":
      return `WebRTC media timed out while ${error.progress}`;
    case "producer-resize-failed":
      return `WebRTC resize failed: ${error.detail}`;
    case "unexpected":
      return error.cause instanceof Error ? error.cause.message : "WebRTC media failed";
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
}

export type WebRTCMediaState = {
  phase: WebRTCMediaPhase;
  stream: MediaStream | null;
  size: WebRTCMediaSize | null;
  streamSettings: WebRTCStreamSettings | null;
  metrics: WebRTCMediaMetrics | null;
  error: WebRTCMediaError | null;
  inputReady: boolean;
};

export type WebRTCInputMessage =
  | Extract<ClientMessage, { type: "input.mouse" }>
  | Extract<ClientMessage, { type: "input.wheel" }>
  | Extract<ClientMessage, { type: "input.key" }>;

export type WebRTCMediaOptions = {
  sessionId: string;
  sessionToken: string;
  credentials: ApiCredentials;
  iceServers: RTCIceServer[];
  input$: Observable<WebRTCInputMessage>;
  viewportSize$: Observable<WebRTCViewportRequest>;
  streamSettings$: Observable<WebRTCStreamSettings>;
};

type SignalMessage =
  | { type: "sdp-offer"; payload: unknown }
  | { type: "ice-candidate"; payload: unknown }
  | { type: "viewport-metadata"; payload: unknown }
  | { type: "stream-settings"; payload: unknown }
  | { type: "producer-health"; payload: unknown };

type SignalOutboundFrame =
  | { type: "viewer-ready"; payload: unknown }
  | { type: "sdp-answer"; payload: unknown }
  | { type: "ice-candidate"; payload: unknown }
  | { type: "viewport-resize"; payload: unknown }
  | { type: "stream-settings"; payload: unknown }
  | { type: "viewer-health"; payload: unknown };

type SignalFrame = SignalMessage | SignalOutboundFrame;

type ProducerHealth = {
  status: string;
  code: string | null;
  message: string | null;
};

type ViewerHealthDetails = {
  message?: string;
  candidate?: string;
};

type TransportEvent =
  | { type: "progress"; detail: string }
  | { type: "stream"; stream: MediaStream }
  | { type: "probe-live"; size: WebRTCMediaSize }
  | { type: "viewport-metadata"; size: WebRTCMediaSize }
  | { type: "stream-settings"; settings: WebRTCStreamSettings }
  | { type: "input-ready"; ready: boolean }
  | { type: "input-rtt"; rttMs: number | null }
  | { type: "metrics"; metrics: WebRTCMediaMetrics }
  | { type: "producer-health"; health: ProducerHealth }
  | { type: "soft-error"; error: Extract<WebRTCMediaError, { kind: "producer-resize-failed" }> }
  | { type: "viewer-health"; status: string; details?: ViewerHealthDetails }
  | { type: "fatal"; failure: WebRTCMediaFailure };

type WebRTCMediaStateInternal = WebRTCMediaState & {
  progress: string;
  logicalSize: WebRTCMediaSize | null;
};

type SignalSocket = {
  inbound$: Observable<SignalMessage>;
  open$: Observable<void>;
  send: (frame: SignalOutboundFrame) => void;
};

type StatsSample = {
  timestamp: number;
  bytesReceived: number;
  framesDecoded: number;
};

type StatsAccumulator = {
  sample: StatsSample | null;
  metrics: WebRTCMediaMetrics;
};

type InputRttSample =
  | { type: "ping"; seq: number; at: number }
  | { type: "pong"; seq: number; at: number };

const SIGNAL_PROTOCOL = "aperture-webrtc.v1";
const WEBRTC_MEDIA_TIMEOUT_MS = 20_000;
const WEBRTC_VIEWPORT_RESIZE_INTERVAL_MS = 32;
const WEBRTC_STATS_INTERVAL_MS = 1000;
const WEBRTC_INPUT_PING_INTERVAL_MS = 1000;
const WEBRTC_SIGNAL_RECONNECT_MIN_MS = 250;
const WEBRTC_SIGNAL_RECONNECT_MAX_MS = 2000;

const jsonTextSchema = z.string().transform((data, ctx) => {
  try {
    const value: unknown = JSON.parse(data);
    return value;
  } catch {
    ctx.addIssue({ code: "custom", message: "invalid JSON" });
    return z.NEVER;
  }
});
const signalPayloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("sdp-offer"), payload: z.unknown() }),
  z.object({ type: z.literal("ice-candidate"), payload: z.unknown() }),
  z.object({ type: z.literal("viewport-metadata"), payload: z.unknown() }),
  z.object({ type: z.literal("stream-settings"), payload: z.unknown() }),
  z.object({ type: z.literal("producer-health"), payload: z.unknown() }),
]);
const inputPongSchema = jsonTextSchema.pipe(
  z.object({ type: z.literal("input.pong"), seq: z.number().int() }),
);
const sessionDescriptionSchema = z.object({
  type: z.literal("offer"),
  sdp: z.string(),
});
const iceCandidateSchema = z.object({
  candidate: z.string(),
  sdpMid: z.string().nullable().optional(),
  sdpMLineIndex: z.number().nullable().optional(),
  usernameFragment: z.string().nullable().optional(),
});
const viewportMetadataSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  deviceScaleFactor: z.number().positive().default(1),
  physicalWidth: z.number().positive().optional(),
  physicalHeight: z.number().positive().optional(),
});
const streamSettingsSchema = z.object({
  fps: z.number().int().min(1).max(120),
  bitrateKbps: z.number().int().min(1).max(50_000),
  keyframeInterval: z.number().int().min(1).max(600),
});
const producerHealthSchema = z.object({
  status: z.string(),
  code: z.string().nullable().optional(),
  message: z.string().nullable().optional(),
});
const inboundVideoStatsSchema = z
  .object({
    type: z.literal("inbound-rtp"),
    kind: z.literal("video"),
    timestamp: z.number().finite(),
    bytesReceived: z.number().finite().optional(),
    framesDecoded: z.number().finite().optional(),
    framesPerSecond: z.number().finite().optional(),
    frameWidth: z.number().finite().optional(),
    frameHeight: z.number().finite().optional(),
    framesDropped: z.number().finite().optional(),
    packetsLost: z.number().finite().optional(),
    jitter: z.number().finite().optional(),
    jitterBufferDelay: z.number().finite().optional(),
    jitterBufferEmittedCount: z.number().finite().optional(),
    codecId: z.string().optional(),
  })
  .passthrough();
const candidatePairStatsSchema = z
  .object({
    type: z.literal("candidate-pair"),
    state: z.string().optional(),
    nominated: z.boolean().optional(),
    selected: z.boolean().optional(),
    currentRoundTripTime: z.number().finite().optional(),
    localCandidateId: z.string().optional(),
    remoteCandidateId: z.string().optional(),
  })
  .passthrough();
const codecStatsSchema = z.object({ mimeType: z.string().optional() }).passthrough();
const candidateStatsSchema = z.object({ candidateType: z.string().optional() }).passthrough();

const initialState: WebRTCMediaState = {
  phase: "idle",
  stream: null,
  size: null,
  streamSettings: null,
  metrics: null,
  error: null,
  inputReady: false,
};

const connectingState: WebRTCMediaStateInternal = {
  ...initialState,
  phase: "connecting",
  progress: "starting",
  logicalSize: null,
};

const emptyMetrics: WebRTCMediaMetrics = {
  receivedBitrateKbps: null,
  decodedFps: null,
  frameWidth: null,
  frameHeight: null,
  framesDecoded: null,
  framesDropped: null,
  packetsLost: null,
  jitterMs: null,
  jitterBufferDelayMs: null,
  roundTripTimeMs: null,
  inputRttMs: null,
  codec: null,
  candidatePair: null,
};

const initialStatsAccumulator: StatsAccumulator = {
  sample: null,
  metrics: emptyMetrics,
};

class TransportError extends Error {
  constructor(readonly failure: WebRTCMediaFailure) {
    super(webRTCMediaErrorMessage(failure));
  }
}

class SignalSocketClosed extends Error {
  constructor() {
    super("WebRTC signaling closed");
  }
}

export function webRTCMedia$(options: WebRTCMediaOptions): Observable<WebRTCMediaState> {
  return defer((): Observable<WebRTCMediaState> => {
    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection({ iceServers: options.iceServers });
    } catch (cause) {
      return of<WebRTCMediaState>({
        ...initialState,
        phase: "failed",
        error: { kind: "setup-failed", cause },
      });
    }

    const signal = signalSocket(options.sessionId, options.sessionToken);
    const peerEvents$ = peerConnection$(pc, signal.send).pipe(share());
    const stream$ = peerEvents$.pipe(
      filter(
        (event): event is Extract<TransportEvent, { type: "stream" }> => event.type === "stream",
      ),
      map((event) => event.stream),
      distinctUntilChanged(),
    );
    const mediaEvents$ = stream$.pipe(
      switchMap((stream) => probe$(stream)),
      share(),
    );
    const live$ = mediaEvents$.pipe(
      filter((event) => event.type === "probe-live"),
      take(1),
    );
    const inputEvents$ = inputChannel$(pc, options.input$).pipe(share());
    const inputRtt$ = inputEvents$.pipe(
      filter(
        (event): event is Extract<TransportEvent, { type: "input-rtt" }> =>
          event.type === "input-rtt",
      ),
      map((event) => event.rttMs),
    );
    const producerEvents$ = producerHealth$(signal.inbound$).pipe(share());
    const metadataEvents$ = metadata$(signal.inbound$);
    const sourceEvents$ = merge(
      signal.open$.pipe(
        mergeMap(() =>
          from([
            { type: "progress", detail: "signaling open" },
            { type: "viewer-health", status: "signaling-open" },
          ] satisfies TransportEvent[]),
        ),
      ),
      negotiation$(pc, signal.inbound$, signal.send),
      peerEvents$,
      mediaEvents$,
      inputEvents$,
      producerEvents$,
      metadataEvents$,
      stats$(pc, live$, inputRtt$),
    ).pipe(share());
    const progress$ = sourceEvents$.pipe(
      filter(
        (event): event is Extract<TransportEvent, { type: "progress" }> =>
          event.type === "progress",
      ),
      map((event) => event.detail),
      startWith("starting"),
    );
    const timeout$ = timer(WEBRTC_MEDIA_TIMEOUT_MS).pipe(
      takeUntil(live$),
      withLatestFrom(progress$),
      map(
        ([, progress]): TransportEvent => ({
          type: "fatal",
          failure: { kind: "media-timeout", progress },
        }),
      ),
    );
    const events$ = merge(sourceEvents$, timeout$).pipe(share());
    const state$ = events$.pipe(
      scan(reduce, connectingState),
      startWith(connectingState),
      shareReplay({ bufferSize: 1, refCount: true }),
    );
    const outboundSync$ = signal.open$.pipe(
      switchMap(() =>
        merge(
          of<SignalOutboundFrame>({ type: "viewer-ready", payload: {} }),
          options.viewportSize$.pipe(
            auditTime(WEBRTC_VIEWPORT_RESIZE_INTERVAL_MS),
            map((size): SignalOutboundFrame => ({ type: "viewport-resize", payload: size })),
          ),
          options.streamSettings$.pipe(
            map(
              (settings): SignalOutboundFrame => ({ type: "stream-settings", payload: settings }),
            ),
          ),
        ),
      ),
      tap((frame) => signal.send(frame)),
      ignoreElements(),
    );
    const producerReady$ = producerEvents$.pipe(
      filter(
        (event): event is Extract<TransportEvent, { type: "producer-health" }> =>
          event.type === "producer-health",
      ),
      filter(
        (event) =>
          event.health.status === "idle" ||
          event.health.status === "starting" ||
          event.health.status === "negotiating",
      ),
      withLatestFrom(state$),
      filter(([, state]) => state.phase !== "live"),
      tap(() => signal.send({ type: "viewer-ready", payload: {} })),
      ignoreElements(),
    );
    const healthReporter$ = merge(
      events$.pipe(
        filter(
          (event): event is Extract<TransportEvent, { type: "viewer-health" }> =>
            event.type === "viewer-health",
        ),
      ),
      state$.pipe(
        filter((state) => state.phase === "live"),
        take(1),
        map(
          (): Extract<TransportEvent, { type: "viewer-health" }> => ({
            type: "viewer-health",
            status: "live",
          }),
        ),
      ),
    ).pipe(
      tap((event) => reportHealth(pc, signal.send, event.status, event.details)),
      ignoreElements(),
    );

    return merge(outboundSync$, producerReady$, healthReporter$, state$).pipe(
      tap((state) => {
        if (state.phase === "failed" && state.error) {
          reportHealth(pc, signal.send, "failed", {
            message: webRTCMediaErrorMessage(state.error),
          });
          console.warn("WebRTC media failed", state.error);
        }
      }),
      takeWhile((state) => state.phase !== "failed", true),
      map(({ progress: _progress, logicalSize: _logicalSize, ...state }) => state),
      catchError((cause: unknown) => {
        const failure: WebRTCMediaFailure =
          cause instanceof TransportError ? cause.failure : { kind: "unexpected", cause };
        console.warn("WebRTC media failed", failure);
        return of<WebRTCMediaState>({ ...initialState, phase: "failed", error: failure });
      }),
      finalize(() => pc.close()),
    );
  });
}

function reduce(state: WebRTCMediaStateInternal, event: TransportEvent): WebRTCMediaStateInternal {
  switch (event.type) {
    case "progress":
      return { ...state, progress: event.detail };
    case "stream":
      return { ...state, stream: event.stream };
    case "probe-live":
      return {
        ...state,
        phase: "live",
        size: state.logicalSize ?? event.size,
        error: null,
        progress: "live",
      };
    case "viewport-metadata":
      return { ...state, logicalSize: event.size, size: event.size, error: null };
    case "stream-settings":
      return { ...state, streamSettings: event.settings, error: null };
    case "input-ready":
      return { ...state, inputReady: event.ready };
    case "metrics":
      return { ...state, metrics: event.metrics };
    case "soft-error":
      return { ...state, error: event.error };
    case "fatal":
      return {
        ...state,
        phase: "failed",
        stream: null,
        metrics: null,
        inputReady: false,
        error: event.failure,
      };
    case "input-rtt":
    case "producer-health":
    case "viewer-health":
      return state;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

function signalSocket(sessionId: string, sessionToken: string): SignalSocket {
  const open$ = new Subject<void>();
  let socket: WebSocketSubject<SignalFrame> | null = null;
  const inbound$ = defer(() => {
    const nextSocket = webSocket<SignalFrame>({
      url: buildSignalURL(sessionId),
      protocol: buildSignalProtocols(sessionToken),
      serializer: (frame) => JSON.stringify(frame),
      deserializer: (event) => parseSignalMessage(event.data),
      openObserver: { next: () => open$.next() },
    });
    socket = nextSocket;
    return concat(
      nextSocket.pipe(filter((frame): frame is SignalMessage => isInboundSignal(frame))),
      throwError(() => new SignalSocketClosed()),
    ).pipe(
      finalize(() => {
        if (socket === nextSocket) {
          socket = null;
        }
      }),
    );
  }).pipe(
    retry({
      delay: (cause: unknown, attempt) =>
        cause instanceof TransportError
          ? throwError(() => cause)
          : timer(
              Math.min(
                WEBRTC_SIGNAL_RECONNECT_MAX_MS,
                WEBRTC_SIGNAL_RECONNECT_MIN_MS * 2 ** (attempt - 1),
              ),
            ),
      resetOnSuccess: true,
    }),
    share(),
  );

  return {
    inbound$,
    open$: open$.asObservable(),
    send: (frame) => {
      if (!socket) {
        console.warn("WebRTC signaling send skipped", { type: frame.type });
        return;
      }
      socket.next(frame);
    },
  };
}

function metadata$(inbound$: Observable<SignalMessage>): Observable<TransportEvent> {
  return inbound$.pipe(
    mergeMap((message) => {
      if (message.type === "viewport-metadata") {
        const parsed = viewportMetadataSchema.safeParse(message.payload);
        return parsed.success
          ? of<TransportEvent>({
              type: "viewport-metadata",
              size: {
                width: Math.round(parsed.data.width),
                height: Math.round(parsed.data.height),
                deviceScaleFactor: parsed.data.deviceScaleFactor,
                physicalWidth: Math.round(parsed.data.physicalWidth ?? parsed.data.width),
                physicalHeight: Math.round(parsed.data.physicalHeight ?? parsed.data.height),
              },
            })
          : EMPTY;
      }
      if (message.type === "stream-settings") {
        const parsed = streamSettingsSchema.safeParse(message.payload);
        return parsed.success
          ? of<TransportEvent>({ type: "stream-settings", settings: parsed.data })
          : EMPTY;
      }
      return EMPTY;
    }),
  );
}

function negotiation$(
  pc: RTCPeerConnection,
  inbound$: Observable<SignalMessage>,
  send: SignalSocket["send"],
): Observable<TransportEvent> {
  return inbound$.pipe(
    filter(
      (message): message is Extract<SignalMessage, { type: "sdp-offer" | "ice-candidate" }> =>
        message.type === "sdp-offer" || message.type === "ice-candidate",
    ),
    concatMap((message) =>
      from(
        message.type === "sdp-offer"
          ? answerOffer(pc, message.payload, send)
          : addRemoteCandidate(pc, message.payload),
      ).pipe(
        mergeMap((events) => from(events)),
        catchError((cause: unknown) =>
          of<TransportEvent>({
            type: "fatal",
            failure:
              cause instanceof TransportError
                ? cause.failure
                : { kind: "negotiation-failed", cause },
          }),
        ),
      ),
    ),
  );
}

async function answerOffer(
  pc: RTCPeerConnection,
  payload: unknown,
  send: SignalSocket["send"],
): Promise<TransportEvent[]> {
  if (pc.signalingState === "have-remote-offer") {
    return [{ type: "viewer-health", status: "duplicate-offer-ignored" }];
  }
  const offer = parseSessionDescription(payload);
  if (!offer) {
    throw new TransportError({ kind: "invalid-sdp-offer" });
  }
  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  const localDescription = pc.localDescription;
  if (!localDescription) {
    throw new TransportError({ kind: "missing-local-answer" });
  }
  send({ type: "sdp-answer", payload: localDescription.toJSON() });
  return [
    { type: "viewer-health", status: "offer-received" },
    { type: "progress", detail: "answer sent" },
    { type: "viewer-health", status: "answer-sent" },
  ];
}

async function addRemoteCandidate(
  pc: RTCPeerConnection,
  payload: unknown,
): Promise<TransportEvent[]> {
  const candidate = parseIceCandidate(payload);
  if (!candidate) {
    throw new TransportError({ kind: "invalid-ice-candidate" });
  }
  await pc.addIceCandidate(candidate);
  return [
    {
      type: "viewer-health",
      status: "remote-candidate",
      details: { candidate: candidate.candidate },
    },
  ];
}

function peerConnection$(
  pc: RTCPeerConnection,
  send: SignalSocket["send"],
): Observable<TransportEvent> {
  return merge(
    fromEvent<RTCPeerConnectionIceEvent>(pc, "icecandidate").pipe(
      mergeMap((event) => {
        if (!event.candidate) {
          return EMPTY;
        }
        send({ type: "ice-candidate", payload: event.candidate.toJSON() });
        return of<TransportEvent>({
          type: "viewer-health",
          status: "local-candidate",
          details: { candidate: event.candidate.candidate },
        });
      }),
    ),
    fromEvent(pc, "icegatheringstatechange").pipe(
      mergeMap(() =>
        from([
          { type: "progress", detail: `ICE gathering ${pc.iceGatheringState}` },
          { type: "viewer-health", status: "ice-gathering" },
        ] satisfies TransportEvent[]),
      ),
    ),
    fromEvent<RTCTrackEvent>(pc, "track").pipe(
      mergeMap((event) => {
        const [remoteStream] = event.streams;
        const stream = remoteStream ?? new MediaStream([event.track]);
        const events: TransportEvent[] = [{ type: "stream", stream }];
        if (event.track.kind === "video") {
          events.push(
            {
              type: "progress",
              detail: event.track.muted ? "video track muted" : "video track received",
            },
            { type: "viewer-health", status: "video-track" },
          );
        }
        return from(events);
      }),
    ),
    fromEvent(pc, "connectionstatechange").pipe(
      mergeMap(() => {
        const events: TransportEvent[] = [
          { type: "progress", detail: `connection ${pc.connectionState}` },
          { type: "viewer-health", status: "peer-connection" },
        ];
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          events.push({
            type: "fatal",
            failure: { kind: "peer-connection-lost", state: pc.connectionState },
          });
        }
        return from(events);
      }),
    ),
    fromEvent(pc, "iceconnectionstatechange").pipe(
      mergeMap(() => {
        const events: TransportEvent[] = [
          { type: "progress", detail: `ICE ${pc.iceConnectionState}` },
          { type: "viewer-health", status: "ice-connection" },
        ];
        if (pc.iceConnectionState === "failed") {
          events.push({ type: "fatal", failure: { kind: "ice-failed" } });
        }
        return from(events);
      }),
    ),
  );
}

function producerHealth$(inbound$: Observable<SignalMessage>): Observable<TransportEvent> {
  return inbound$.pipe(
    filter(
      (message): message is Extract<SignalMessage, { type: "producer-health" }> =>
        message.type === "producer-health",
    ),
    mergeMap((message) => {
      const health = parseProducerHealth(message.payload);
      if (!health) {
        return EMPTY;
      }
      const events: TransportEvent[] = [{ type: "producer-health", health }];
      if (health.status === "connected" || health.status === "streaming") {
        events.push({ type: "progress", detail: `producer ${health.status}` });
      }
      if (health.status === "input-failed") {
        console.warn("WebRTC producer input failed", health);
      }
      if (health.status === "resize-failed") {
        console.warn("WebRTC producer resize failed", health);
        events.push({
          type: "soft-error",
          error: {
            kind: "producer-resize-failed",
            detail: health.message ?? health.code ?? "resize failed",
          },
        });
      }
      if (health.status === "failed" && health.code !== "peer_connection_closed") {
        events.push({
          type: "fatal",
          failure: { kind: "producer-failed", code: health.code, detail: health.message },
        });
      }
      return from(events);
    }),
  );
}

function inputChannel$(
  pc: RTCPeerConnection,
  input$: Observable<WebRTCInputMessage>,
): Observable<TransportEvent> {
  return fromEvent<RTCDataChannelEvent>(pc, "datachannel").pipe(
    switchMap((event) => channelSession$(event.channel, input$)),
  );
}

function channelSession$(
  channel: RTCDataChannel,
  input$: Observable<WebRTCInputMessage>,
): Observable<TransportEvent> {
  if (channel.label !== "input") {
    console.warn("unexpected WebRTC data channel", { label: channel.label });
    return EMPTY;
  }

  const closed$: Observable<"input-channel-closed" | "input-channel-failed"> = merge(
    fromEvent(channel, "close").pipe(map((): "input-channel-closed" => "input-channel-closed")),
    fromEvent(channel, "error").pipe(
      tap(() => console.warn("WebRTC input channel failed")),
      map((): "input-channel-failed" => "input-channel-failed"),
    ),
  ).pipe(take(1), share());
  const open$: Observable<unknown> =
    channel.readyState === "open" ? of(null) : fromEvent(channel, "open").pipe(take(1));
  const sendInput$ = merge(
    input$.pipe(
      filter((message) => message.type === "input.mouse" && message.action === "move"),
      auditTime(0, animationFrameScheduler),
    ),
    input$.pipe(filter((message) => message.type !== "input.mouse" || message.action !== "move")),
  ).pipe(
    tap((message) => sendOnChannel(channel, message)),
    ignoreElements(),
  );
  const ping$ = timer(0, WEBRTC_INPUT_PING_INTERVAL_MS).pipe(
    map((tick): InputRttSample => ({ type: "ping", seq: tick + 1, at: performance.now() })),
    tap((ping) => sendOnChannel(channel, { type: "input.ping", seq: ping.seq })),
  );
  const pong$ = fromEvent<MessageEvent>(channel, "message").pipe(
    mergeMap((event) => {
      const parsed = inputPongSchema.safeParse(event.data);
      return parsed.success
        ? of<InputRttSample>({ type: "pong", seq: parsed.data.seq, at: performance.now() })
        : EMPTY;
    }),
  );
  const rtt$ = merge(ping$, pong$).pipe(
    scan(
      (acc: { pending: Map<number, number>; rttMs: number | null }, sample) => {
        const pending = new Map(acc.pending);
        if (sample.type === "ping") {
          pending.set(sample.seq, sample.at);
          return { pending, rttMs: acc.rttMs };
        }
        const startedAt = pending.get(sample.seq);
        if (startedAt === undefined) {
          return acc;
        }
        pending.delete(sample.seq);
        return { pending, rttMs: sample.at - startedAt };
      },
      { pending: new Map<number, number>(), rttMs: null },
    ),
    mergeMap((acc) =>
      acc.rttMs === null ? EMPTY : of<TransportEvent>({ type: "input-rtt", rttMs: acc.rttMs }),
    ),
  );
  const session$ = open$.pipe(
    switchMap(() =>
      merge(
        from([
          { type: "input-ready", ready: true },
          { type: "viewer-health", status: "input-channel-open" },
        ] satisfies TransportEvent[]),
        sendInput$,
        rtt$,
      ).pipe(takeUntil(closed$)),
    ),
  );
  const closedEvents$ = closed$.pipe(
    mergeMap((status) =>
      from([
        { type: "viewer-health", status },
        { type: "input-ready", ready: false },
        { type: "input-rtt", rttMs: null },
      ] satisfies TransportEvent[]),
    ),
  );

  return merge(session$, closedEvents$);
}

function sendOnChannel(channel: RTCDataChannel, message: unknown) {
  try {
    channel.send(JSON.stringify(message));
  } catch (cause) {
    console.warn("WebRTC input send failed", cause);
  }
}

function probe$(stream: MediaStream): Observable<TransportEvent> {
  return new Observable<TransportEvent>((subscriber) => {
    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;

    let lastSize: WebRTCMediaSize | null = null;
    const emitSize = () => {
      if (
        video.videoWidth < 1 ||
        video.videoHeight < 1 ||
        video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
      ) {
        return;
      }
      if (
        lastSize?.physicalWidth === video.videoWidth &&
        lastSize?.physicalHeight === video.videoHeight
      ) {
        return;
      }
      lastSize = {
        width: video.videoWidth,
        height: video.videoHeight,
        deviceScaleFactor: 1,
        physicalWidth: video.videoWidth,
        physicalHeight: video.videoHeight,
      };
      subscriber.next({ type: "probe-live", size: lastSize });
    };
    const play = () => {
      video
        .play()
        .then(emitSize)
        .catch((cause: unknown) => {
          const message = cause instanceof Error ? cause.message : "video playback failed";
          subscriber.next({ type: "progress", detail: `video playback ${message}` });
          subscriber.next({
            type: "viewer-health",
            status: "video-playback-failed",
            details: { message },
          });
        });
    };

    const subscriptions = new Subscription();
    subscriptions.add(
      merge(
        fromEvent(video, "loadedmetadata"),
        fromEvent(video, "loadeddata"),
        fromEvent(video, "canplay"),
        fromEvent(video, "playing"),
        fromEvent(video, "resize"),
      ).subscribe(emitSize),
    );
    subscriptions.add(
      merge(...stream.getVideoTracks().map((track) => fromEvent(track, "unmute"))).subscribe(() => {
        subscriber.next({ type: "progress", detail: "video track unmuted" });
        subscriber.next({ type: "viewer-health", status: "video-track-unmuted" });
        play();
        emitSize();
      }),
    );
    play();

    return () => {
      subscriptions.unsubscribe();
      video.pause();
      video.srcObject = null;
    };
  });
}

function stats$(
  pc: RTCPeerConnection,
  live$: Observable<unknown>,
  inputRtt$: Observable<number | null>,
): Observable<TransportEvent> {
  return live$.pipe(
    switchMap(() => timer(0, WEBRTC_STATS_INTERVAL_MS)),
    exhaustMap(() =>
      from(pc.getStats()).pipe(
        catchError((cause: unknown) => {
          console.warn("WebRTC stats collection failed", cause);
          return EMPTY;
        }),
      ),
    ),
    withLatestFrom(inputRtt$.pipe(startWith(null))),
    scan(
      (acc: StatsAccumulator, [report, inputRttMs]) =>
        deriveMetrics(report, acc.sample, inputRttMs),
      initialStatsAccumulator,
    ),
    map((acc): TransportEvent => ({ type: "metrics", metrics: acc.metrics })),
  );
}

function reportHealth(
  pc: RTCPeerConnection,
  send: SignalSocket["send"],
  status: string,
  details: ViewerHealthDetails = {},
) {
  const payload: Record<string, string> = {
    status,
    connectionState: pc.connectionState,
    iceConnectionState: pc.iceConnectionState,
    iceGatheringState: pc.iceGatheringState,
  };
  if (details.message) {
    payload.message = details.message;
  }
  if (details.candidate) {
    payload.candidate = details.candidate;
  }
  send({ type: "viewer-health", payload });
}

function deriveMetrics(
  report: RTCStatsReport,
  previousSample: StatsSample | null,
  inputRttMs: number | null,
): StatsAccumulator {
  const stats: RTCStats[] = [];
  report.forEach((stat) => stats.push(stat));

  let inbound: z.infer<typeof inboundVideoStatsSchema> | null = null;
  const candidatePairs: Array<z.infer<typeof candidatePairStatsSchema>> = [];
  for (const stat of stats) {
    const parsedInbound = inboundVideoStatsSchema.safeParse(stat);
    if (parsedInbound.success) {
      inbound = parsedInbound.data;
    }
    const parsedCandidatePair = candidatePairStatsSchema.safeParse(stat);
    if (parsedCandidatePair.success) {
      candidatePairs.push(parsedCandidatePair.data);
    }
  }

  const candidatePair =
    candidatePairs.find((stat) => stat.state === "succeeded" && stat.nominated) ??
    candidatePairs.find((stat) => stat.selected) ??
    null;
  const codec = inbound?.codecId ? parseCodecStats(report.get(inbound.codecId)) : null;
  const localCandidate = candidatePair?.localCandidateId
    ? parseCandidateStats(report.get(candidatePair.localCandidateId))
    : null;
  const remoteCandidate = candidatePair?.remoteCandidateId
    ? parseCandidateStats(report.get(candidatePair.remoteCandidateId))
    : null;
  const bytesReceived = inbound?.bytesReceived ?? null;
  const framesDecoded = inbound?.framesDecoded ?? null;
  const timestamp = inbound?.timestamp ?? null;
  let receivedBitrateKbps: number | null = null;
  let decodedFps = inbound?.framesPerSecond ?? null;
  let sample: StatsSample | null = previousSample;

  if (timestamp !== null && bytesReceived !== null && framesDecoded !== null) {
    sample = { timestamp, bytesReceived, framesDecoded };
    if (previousSample && sample.timestamp > previousSample.timestamp) {
      const elapsedSeconds = (sample.timestamp - previousSample.timestamp) / 1000;
      receivedBitrateKbps =
        ((sample.bytesReceived - previousSample.bytesReceived) * 8) / elapsedSeconds / 1000;
      decodedFps =
        decodedFps ?? (sample.framesDecoded - previousSample.framesDecoded) / elapsedSeconds;
    }
  }

  const jitterBufferDelayMs =
    inbound?.jitterBufferDelay !== undefined && inbound.jitterBufferEmittedCount
      ? (inbound.jitterBufferDelay / inbound.jitterBufferEmittedCount) * 1000
      : null;

  return {
    sample,
    metrics: {
      receivedBitrateKbps,
      decodedFps,
      frameWidth: inbound?.frameWidth ?? null,
      frameHeight: inbound?.frameHeight ?? null,
      framesDecoded,
      framesDropped: inbound?.framesDropped ?? null,
      packetsLost: inbound?.packetsLost ?? null,
      jitterMs: secondsToMs(inbound?.jitter ?? null),
      jitterBufferDelayMs,
      roundTripTimeMs: secondsToMs(candidatePair?.currentRoundTripTime ?? null),
      inputRttMs,
      codec: codec?.mimeType ?? null,
      candidatePair:
        localCandidate?.candidateType && remoteCandidate?.candidateType
          ? `${localCandidate.candidateType}->${remoteCandidate.candidateType}`
          : null,
    },
  };
}

function buildSignalURL(sessionId: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/sessions/${encodeURIComponent(sessionId)}/webrtc/signal?role=viewer`;
}

function buildSignalProtocols(sessionToken: string): string[] {
  return [SIGNAL_PROTOCOL, `authorization.bearer.${sessionToken}`];
}

function parseSignalMessage(data: unknown): SignalMessage {
  const parsed = jsonTextSchema.pipe(signalPayloadSchema).safeParse(data);
  if (!parsed.success) {
    throw new TransportError({ kind: "signaling-invalid-message" });
  }
  return parsed.data;
}

function isInboundSignal(frame: SignalFrame): frame is SignalMessage {
  switch (frame.type) {
    case "sdp-offer":
    case "ice-candidate":
    case "viewport-metadata":
    case "stream-settings":
    case "producer-health":
      return true;
    case "viewer-ready":
    case "sdp-answer":
    case "viewport-resize":
    case "viewer-health":
      return false;
    default: {
      const exhaustive: never = frame;
      return exhaustive;
    }
  }
}

function parseSessionDescription(payload: unknown): RTCSessionDescriptionInit | null {
  const parsed = sessionDescriptionSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

function parseIceCandidate(payload: unknown): RTCIceCandidateInit | null {
  const parsed = iceCandidateSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }
  const candidate: RTCIceCandidateInit = { candidate: parsed.data.candidate };
  if (parsed.data.sdpMid !== undefined) {
    candidate.sdpMid = parsed.data.sdpMid;
  }
  if (parsed.data.sdpMLineIndex !== undefined) {
    candidate.sdpMLineIndex = parsed.data.sdpMLineIndex;
  }
  if (parsed.data.usernameFragment) {
    candidate.usernameFragment = parsed.data.usernameFragment;
  }
  return candidate;
}

function parseProducerHealth(payload: unknown): ProducerHealth | null {
  const parsed = producerHealthSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }
  return {
    status: parsed.data.status,
    code: parsed.data.code ?? null,
    message: parsed.data.message ?? null,
  };
}

function parseCodecStats(stat: RTCStats | undefined) {
  const parsed = codecStatsSchema.safeParse(stat);
  return parsed.success ? parsed.data : null;
}

function parseCandidateStats(stat: RTCStats | undefined) {
  const parsed = candidateStatsSchema.safeParse(stat);
  return parsed.success ? parsed.data : null;
}

function secondsToMs(value: number | null): number | null {
  return value === null ? null : value * 1000;
}
