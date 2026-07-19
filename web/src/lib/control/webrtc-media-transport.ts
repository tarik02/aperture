import {
  Observable,
  Subscription,
  animationFrameScheduler,
  auditTime,
  distinctUntilChanged,
  filter,
  merge,
} from "rxjs";
import { z } from "zod";
import { TENANT_HEADER, resolveTenantHeader, type ApiCredentials } from "#/lib/api/client.ts";
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
  profile: string;
  fps: number;
  bitrateKbps: number;
  keyframeInterval: number;
};

export type WebRTCVideoProfile = {
  id: string;
  label: string;
  codec: string;
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
  | { kind: "producer-resize-failed"; detail: string }
  | { kind: "producer-quality-failed"; detail: string };

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
    case "producer-quality-failed":
      return `WebRTC stream update failed: ${error.detail}`;
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
  videoProfiles: WebRTCVideoProfile[];
  metrics: WebRTCMediaMetrics | null;
  error: WebRTCMediaError | null;
  inputReady: boolean;
};

export type WebRTCInputMessage =
  | Extract<ClientMessage, { type: "input.mouse" }>
  | Extract<ClientMessage, { type: "input.wheel" }>;

export type WebRTCMediaOptions = {
  sessionId: string;
  credentials: ApiCredentials;
  iceServers: RTCIceServer[];
  input$: Observable<WebRTCInputMessage>;
  viewportSize$: Observable<WebRTCViewportRequest>;
  streamSettings$: Observable<WebRTCStreamSettings>;
  reconnect: () => void;
};

type WebRTCPointerButton = NonNullable<
  Extract<WebRTCInputMessage, { type: "input.mouse" }>["button"]
>;

type StatsSample = {
  timestamp: number;
  bytesReceived: number;
  framesDecoded: number;
};

type StatsAccumulator = {
  sample: StatsSample | null;
  metrics: WebRTCMediaMetrics;
};

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
const controlResponseSchema = z.discriminatedUnion("type", [
  z
    .object({
      version: z.literal(3),
      id: z.string(),
      type: z.literal("input.acquire.result"),
      ok: z.literal(true),
      input: z.object({ pointer: z.boolean(), keyboard: z.boolean() }).strict(),
    })
    .strict(),
  z
    .object({
      version: z.literal(3),
      id: z.string(),
      type: z.literal("video.quality.set.result"),
      ok: z.literal(true),
      quality: z
        .object({
          profile: z.string(),
          option: z.string(),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
          framerate: z.number().int().positive(),
          bitrate_kbps: z.number().int().positive(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      version: z.literal(3),
      id: z.string(),
      type: z.literal("error"),
      ok: z.literal(false),
      error: z.object({ code: z.string(), message: z.string() }).strict(),
    })
    .strict(),
]);
const mediaStatusSchema = z
  .object({
    mediaQuality: z
      .object({
        profile: z.string(),
        option: z.string(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        framerate: z.number().int().positive(),
        bitrateKbps: z.number().int().positive(),
      })
      .strict(),
    mediaProfiles: z.array(
      z
        .object({
          id: z.string(),
          label: z.string(),
          codec: z.string(),
        })
        .strict(),
    ),
    mediaKeyframeInterval: z.number().int().positive(),
  })
  .passthrough();
const viewportMetadataSchema = z
  .object({
    width: z.number().positive(),
    height: z.number().positive(),
    deviceScaleFactor: z.number().positive(),
    physicalWidth: z.number().positive(),
    physicalHeight: z.number().positive(),
  })
  .strict();
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

export function webRTCMedia$(options: WebRTCMediaOptions): Observable<WebRTCMediaState> {
  return new Observable<WebRTCMediaState>((subscriber) => {
    let connection: RTCPeerConnection;
    try {
      connection = new RTCPeerConnection({ iceServers: options.iceServers });
    } catch (cause) {
      subscriber.next({
        phase: "failed",
        stream: null,
        size: null,
        streamSettings: null,
        videoProfiles: [],
        metrics: null,
        error: { kind: "setup-failed", cause },
        inputReady: false,
      });
      subscriber.complete();
      return;
    }

    let state: WebRTCMediaState = {
      phase: "connecting",
      stream: null,
      size: null,
      streamSettings: null,
      videoProfiles: [],
      metrics: null,
      error: null,
      inputReady: false,
    };
    let closed = false;
    let inputSequence = 0;
    let controlRequest = 0;
    let keyframeInterval = 60;
    let mediaStatusLoaded = false;
    let pendingStreamSettings: WebRTCStreamSettings | null = null;
    let reconnectAfterProfileChange = false;
    let viewportRequest = 0;
    let viewportSettled = 0;
    const qualityRequests = new Map<string, WebRTCStreamSettings>();
    let statsSample: StatsSample | null = null;
    let statsTimer: number | null = null;
    let mediaTimeout: number | null = window.setTimeout(() => {
      fail({ kind: "media-timeout", progress: "waiting for video" });
    }, 20_000);
    const pendingSignals: string[] = [];
    const pendingCandidates: RTCIceCandidateInit[] = [];
    const subscriptions = new Subscription();
    const control = connection.createDataChannel("control", { ordered: true });
    const input = connection.createDataChannel("input", { ordered: true });
    connection.addTransceiver("video", { direction: "recvonly" });
    const socket = new WebSocket(
      buildSignalURL(options.sessionId),
      buildSignalProtocols(options.credentials),
    );

    const emit = (patch: Partial<WebRTCMediaState>) => {
      state = { ...state, ...patch };
      subscriber.next(state);
    };
    const fail = (error: WebRTCMediaFailure) => {
      if (closed) {
        return;
      }
      emit({ phase: "failed", error, inputReady: false });
      cleanup();
    };
    const sendSignal = (message: unknown) => {
      const body = JSON.stringify(message);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(body);
        return;
      }
      pendingSignals.push(body);
    };
    const sendInput = (message: Record<string, unknown>) => {
      if (!state.inputReady || input.readyState !== "open") {
        return;
      }
      inputSequence += 1;
      input.send(JSON.stringify({ version: 1, sequence: inputSequence, ...message }));
    };
    const sendStreamSettings = () => {
      if (
        !mediaStatusLoaded ||
        !pendingStreamSettings ||
        control.readyState !== "open" ||
        viewportRequest !== viewportSettled
      ) {
        return;
      }
      controlRequest += 1;
      const id = `quality-${controlRequest}`;
      const profileChanged =
        state.streamSettings !== null &&
        pendingStreamSettings.profile !== state.streamSettings.profile;
      reconnectAfterProfileChange = profileChanged;
      qualityRequests.set(id, pendingStreamSettings);
      control.send(
        JSON.stringify({
          version: 3,
          id,
          type: "video.quality.set",
          quality: {
            ...(profileChanged ? { profile: pendingStreamSettings.profile } : {}),
            ...(state.size
              ? {
                  width: state.size.physicalWidth,
                  height: state.size.physicalHeight,
                }
              : {}),
            framerate: pendingStreamSettings.fps,
            bitrate_kbps: pendingStreamSettings.bitrateKbps,
          },
        }),
      );
    };

    void loadMediaStatus(options)
      .then((status) => {
        keyframeInterval = status.mediaKeyframeInterval;
        mediaStatusLoaded = true;
        emit({
          streamSettings: {
            profile: status.mediaQuality.profile,
            fps: status.mediaQuality.framerate,
            bitrateKbps: status.mediaQuality.bitrateKbps,
            keyframeInterval,
          },
          videoProfiles: status.mediaProfiles,
        });
        sendStreamSettings();
      })
      .catch(() => undefined);

    const sendPointerMotion = (x: number, y: number) => {
      const width = state.size?.width;
      const height = state.size?.height;
      if (!width || !height) {
        return;
      }
      sendInput({
        type: "input.pointer.motion.absolute",
        x: Math.min(1, Math.max(0, x / width)),
        y: Math.min(1, Math.max(0, y / height)),
      });
    };
    const cleanup = () => {
      if (closed) {
        return;
      }
      closed = true;
      subscriptions.unsubscribe();
      if (mediaTimeout !== null) {
        window.clearTimeout(mediaTimeout);
        mediaTimeout = null;
      }
      if (statsTimer !== null) {
        window.clearInterval(statsTimer);
      }
      if (state.inputReady && control.readyState === "open") {
        controlRequest += 1;
        control.send(
          JSON.stringify({
            version: 3,
            id: `input-${controlRequest}`,
            type: "input.release",
          }),
        );
      }
      input.close();
      control.close();
      connection.close();
      socket.close();
    };

    subscriber.next(state);

    socket.addEventListener("open", () => {
      for (const body of pendingSignals.splice(0)) {
        socket.send(body);
      }
      void connection
        .createOffer()
        .then((offer) => connection.setLocalDescription(offer))
        .then(() => {
          const description = connection.localDescription;
          if (!description?.sdp) {
            throw new Error("missing local WebRTC offer");
          }
          sendSignal({ version: 1, type: "offer", sdp: description.sdp });
        })
        .catch((cause: unknown) => fail({ kind: "negotiation-failed", cause }));
    });
    socket.addEventListener("message", (event) => {
      const parsed = z
        .string()
        .transform((body) => JSON.parse(body))
        .pipe(signalResponseSchema)
        .safeParse(event.data);
      if (!parsed.success) {
        fail({ kind: "signaling-invalid-message" });
        return;
      }
      if (parsed.data.type === "error") {
        fail({
          kind: "producer-failed",
          code: parsed.data.error.code,
          detail: parsed.data.error.message,
        });
        return;
      }
      if (parsed.data.type === "answer") {
        void connection
          .setRemoteDescription({ type: "answer", sdp: parsed.data.sdp })
          .then(async () => {
            for (const candidate of pendingCandidates.splice(0)) {
              await connection.addIceCandidate(candidate);
            }
          })
          .catch((cause: unknown) => fail({ kind: "negotiation-failed", cause }));
        return;
      }
      if (!connection.remoteDescription) {
        pendingCandidates.push(parsed.data.candidate);
        return;
      }
      void connection
        .addIceCandidate(parsed.data.candidate)
        .catch(() => fail({ kind: "invalid-ice-candidate" }));
    });
    socket.addEventListener("close", () => {
      if (!closed && reconnectAfterProfileChange) {
        queueMicrotask(options.reconnect);
        return;
      }
      if (!closed && state.phase !== "failed") {
        fail({ kind: "unexpected", cause: new Error("WebRTC signaling closed") });
      }
    });
    socket.addEventListener("error", () => {
      if (reconnectAfterProfileChange) {
        return;
      }
      fail({ kind: "unexpected", cause: new Error("WebRTC signaling failed") });
    });

    connection.addEventListener("icecandidate", (event) => {
      if (event.candidate) {
        sendSignal({ version: 1, type: "ice-candidate", candidate: event.candidate.toJSON() });
      }
    });
    connection.addEventListener("connectionstatechange", () => {
      if (connection.connectionState === "failed" || connection.connectionState === "closed") {
        if (reconnectAfterProfileChange) {
          return;
        }
        fail({ kind: "peer-connection-lost", state: connection.connectionState });
      }
    });
    connection.addEventListener("iceconnectionstatechange", () => {
      if (connection.iceConnectionState === "failed") {
        if (reconnectAfterProfileChange) {
          return;
        }
        fail({ kind: "ice-failed" });
      }
    });
    connection.addEventListener("track", (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      emit({ stream });
      const live = () => {
        if (mediaTimeout !== null) {
          window.clearTimeout(mediaTimeout);
          mediaTimeout = null;
        }
        emit({ phase: "live", stream, error: null });
        if (statsTimer === null) {
          statsTimer = window.setInterval(() => {
            void connection.getStats().then((report) => {
              const result = deriveMetrics(report, statsSample, null);
              statsSample = result.sample;
              emit({ metrics: result.metrics });
            });
          }, 1000);
        }
      };
      if (event.track.muted) {
        event.track.addEventListener("unmute", live, { once: true });
      } else {
        live();
      }
    });

    const acquireInput = () => {
      if (control.readyState !== "open" || input.readyState !== "open" || state.inputReady) {
        return;
      }
      controlRequest += 1;
      control.send(
        JSON.stringify({
          version: 3,
          id: `input-${controlRequest}`,
          type: "input.acquire",
        }),
      );
    };
    control.addEventListener("open", () => {
      acquireInput();
      sendStreamSettings();
    });
    input.addEventListener("open", acquireInput);
    control.addEventListener("message", (event) => {
      const parsed = z
        .string()
        .transform((body) => JSON.parse(body))
        .pipe(controlResponseSchema)
        .safeParse(event.data);
      if (!parsed.success) {
        return;
      }
      if (parsed.data.type === "error") {
        const qualityRequest = qualityRequests.get(parsed.data.id);
        if (qualityRequest) {
          qualityRequests.delete(parsed.data.id);
          reconnectAfterProfileChange = false;
          emit({
            error: {
              kind: "producer-quality-failed",
              detail: parsed.data.error.message,
            },
          });
          return;
        }
        console.warn("WebRTC input acquisition failed", parsed.data.error);
        emit({ inputReady: false });
        return;
      }
      if (parsed.data.type === "video.quality.set.result") {
        qualityRequests.delete(parsed.data.id);
        const previousProfile = state.streamSettings?.profile;
        emit({
          streamSettings: {
            profile: parsed.data.quality.profile,
            fps: parsed.data.quality.framerate,
            bitrateKbps: parsed.data.quality.bitrate_kbps,
            keyframeInterval,
          },
          error: null,
        });
        if (previousProfile && previousProfile !== parsed.data.quality.profile) {
          reconnectAfterProfileChange = true;
        }
        return;
      }
      emit({ inputReady: parsed.data.input.pointer || parsed.data.input.keyboard });
    });
    input.addEventListener("close", () => emit({ inputReady: false }));
    input.addEventListener("error", () => emit({ inputReady: false }));

    const motion$ = options.input$.pipe(
      filter((message) => message.type === "input.mouse" && message.action === "move"),
      auditTime(0, animationFrameScheduler),
    );
    const transitions$ = options.input$.pipe(
      filter((message) => message.type !== "input.mouse" || message.action !== "move"),
    );
    subscriptions.add(
      merge(motion$, transitions$).subscribe((message) => {
        if (message.type === "input.mouse") {
          sendPointerMotion(message.x, message.y);
          const button = pointerButton(message.button);
          if (!button || message.action === "move") {
            return;
          }
          const count = message.action === "doubleClick" ? 2 : 1;
          for (let index = 0; index < count; index += 1) {
            if (message.action === "down") {
              sendInput({ type: "input.pointer.button", button, pressed: true });
            } else if (message.action === "up") {
              sendInput({ type: "input.pointer.button", button, pressed: false });
            } else {
              sendInput({ type: "input.pointer.button", button, pressed: true });
              sendInput({ type: "input.pointer.button", button, pressed: false });
            }
          }
          return;
        }
        sendPointerMotion(message.x, message.y);
        sendInput({
          type: "input.pointer.scroll",
          horizontal: message.deltaX,
          vertical: message.deltaY,
          stop_horizontal: false,
          stop_vertical: false,
        });
        sendInput({
          type: "input.pointer.scroll",
          horizontal: 0,
          vertical: 0,
          stop_horizontal: message.deltaX !== 0,
          stop_vertical: message.deltaY !== 0,
        });
      }),
    );
    subscriptions.add(
      options.viewportSize$.pipe(auditTime(32)).subscribe((viewport) => {
        viewportRequest += 1;
        const request = viewportRequest;
        void updateViewport(options, viewport)
          .then((size) => {
            if (request !== viewportRequest) {
              return;
            }
            viewportSettled = request;
            emit({ size, error: null });
            sendStreamSettings();
          })
          .catch((cause: unknown) => {
            if (request !== viewportRequest) {
              return;
            }
            viewportSettled = request;
            emit({
              error: {
                kind: "producer-resize-failed",
                detail: cause instanceof Error ? cause.message : "resize failed",
              },
            });
            sendStreamSettings();
          });
      }),
    );
    subscriptions.add(
      options.streamSettings$
        .pipe(
          distinctUntilChanged(
            (left, right) =>
              left.profile === right.profile &&
              left.fps === right.fps &&
              left.bitrateKbps === right.bitrateKbps,
          ),
        )
        .subscribe((settings) => {
          pendingStreamSettings = settings;
          sendStreamSettings();
        }),
    );

    return cleanup;
  });
}

function pointerButton(button: WebRTCPointerButton | undefined) {
  switch (button) {
    case undefined:
    case "left":
      return "primary";
    case "middle":
      return "middle";
    case "right":
      return "secondary";
    case "none":
      return null;
    default:
      return null;
  }
}

async function updateViewport(
  options: WebRTCMediaOptions,
  viewport: WebRTCViewportRequest,
): Promise<WebRTCMediaSize> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.credentials.token.trim()}`,
    "Content-Type": "application/json",
  };
  const tenantId = resolveTenantHeader(options.credentials, "tenant-scoped");
  if (tenantId) {
    headers[TENANT_HEADER] = tenantId;
  }
  const response = await fetch(
    `/sessions/${encodeURIComponent(options.sessionId)}/browser/viewport`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(viewport),
    },
  );
  if (!response.ok) {
    throw new Error((await response.text()) || `resize failed with status ${response.status}`);
  }
  return viewportMetadataSchema.parse(await response.json());
}

async function loadMediaStatus(options: WebRTCMediaOptions) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.credentials.token.trim()}`,
  };
  const tenantId = resolveTenantHeader(options.credentials, "tenant-scoped");
  if (tenantId) {
    headers[TENANT_HEADER] = tenantId;
  }
  const response = await fetch(
    `/sessions/${encodeURIComponent(options.sessionId)}/browser/status`,
    {
      headers,
    },
  );
  if (!response.ok) {
    throw new Error((await response.text()) || `status failed with status ${response.status}`);
  }
  return mediaStatusSchema.parse(await response.json());
}

function buildSignalURL(sessionId: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/sessions/${encodeURIComponent(sessionId)}/webrtc/signal`;
}

function buildSignalProtocols(credentials: ApiCredentials): string[] {
  const protocols = ["aperture-webrtc.v1", `authorization.bearer.${credentials.token}`];
  const tenantId = resolveTenantHeader(credentials, "tenant-scoped");
  if (tenantId) {
    protocols.push(`x-aperture-tenant-id.${tenantId}`);
  }
  return protocols;
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
      ...emptyMetrics,
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
