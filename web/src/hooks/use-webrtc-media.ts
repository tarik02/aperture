import { useEffect, useState } from "react";
import { resolveTenantHeader, type ApiCredentials } from "#/lib/api/client.ts";

export type WebRTCMediaPhase = "idle" | "connecting" | "live" | "failed";

type WebRTCMediaSize = {
  width: number;
  height: number;
};

type UseWebRTCMediaOptions = {
  sessionId: string | null;
  credentials: ApiCredentials | null;
  enabled: boolean;
};

type SignalMessage = {
  type: string;
  payload?: unknown;
};

export type UseWebRTCMediaResult = {
  phase: WebRTCMediaPhase;
  stream: MediaStream | null;
  size: WebRTCMediaSize | null;
  error: string | null;
};

const SIGNAL_PROTOCOL = "aperture-webrtc.v1";
const WEBRTC_MEDIA_TIMEOUT_MS = 8000;

export function useWebRTCMedia({
  sessionId,
  credentials,
  enabled,
}: UseWebRTCMediaOptions): UseWebRTCMediaResult {
  const [phase, setPhase] = useState<WebRTCMediaPhase>("idle");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [size, setSize] = useState<WebRTCMediaSize | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !sessionId || !credentials) {
      setPhase("idle");
      setStream(null);
      setSize(null);
      setError(null);
      return;
    }

    setPhase("connecting");
    setStream(null);
    setSize(null);
    setError(null);

    let closed = false;
    let pc: RTCPeerConnection | null = null;
    let socket: WebSocket | null = null;
    let timeout = 0;

    function markLive() {
      if (closed) {
        return;
      }
      window.clearTimeout(timeout);
      setError(null);
      setPhase("live");
    }

    function fail(message: string) {
      if (closed) {
        return;
      }
      closed = true;
      window.clearTimeout(timeout);
      setError(message);
      setPhase("failed");
      setStream(null);
      try {
        socket?.close();
      } catch {
        // The socket may already be closing.
      }
      void pc?.close();
    }

    try {
      pc = new RTCPeerConnection();
      socket = new WebSocket(buildSignalURL(sessionId), buildSignalProtocols(credentials));
    } catch (cause) {
      fail(cause instanceof Error ? cause.message : "WebRTC setup failed");
      return;
    }

    const activePC = pc;
    const activeSocket = socket;

    timeout = window.setTimeout(() => {
      fail("WebRTC media timed out");
    }, WEBRTC_MEDIA_TIMEOUT_MS);

    function send(type: string, payload: Record<string, unknown>) {
      if (activeSocket.readyState !== WebSocket.OPEN) {
        return false;
      }
      activeSocket.send(JSON.stringify({ type, payload }));
      return true;
    }

    activePC.onicecandidate = (event) => {
      if (event.candidate) {
        send("ice-candidate", event.candidate.toJSON() as unknown as Record<string, unknown>);
      }
    };
    activePC.ontrack = (event) => {
      const [remoteStream] = event.streams;
      setStream(remoteStream ?? new MediaStream([event.track]));
      if (event.track.kind === "video") {
        event.track.addEventListener("unmute", markLive, { once: true });
        if (!event.track.muted) {
          markLive();
        }
      }
    };
    activePC.onconnectionstatechange = () => {
      if (activePC.connectionState === "connected") {
        setError(null);
      }
      if (
        activePC.connectionState === "failed" ||
        activePC.connectionState === "disconnected" ||
        activePC.connectionState === "closed"
      ) {
        fail(`WebRTC ${activePC.connectionState}`);
      }
    };

    activeSocket.addEventListener("open", () => {
      send("viewer-ready", {});
    });
    activeSocket.addEventListener("message", (event) => {
      void handleSignalMessage(event.data);
    });
    activeSocket.addEventListener("close", () => {
      if (!closed && activePC.connectionState !== "connected") {
        fail("WebRTC signaling closed");
      }
    });
    activeSocket.addEventListener("error", () => {
      fail("WebRTC signaling failed");
    });

    async function handleSignalMessage(data: unknown) {
      if (closed || typeof data !== "string") {
        return;
      }

      let message: SignalMessage;
      try {
        message = JSON.parse(data) as SignalMessage;
      } catch {
        fail("WebRTC signaling message is invalid");
        return;
      }

      try {
        if (message.type === "sdp-offer") {
          await activePC.setRemoteDescription(message.payload as RTCSessionDescriptionInit);
          const answer = await activePC.createAnswer();
          await activePC.setLocalDescription(answer);
          const localDescription = activePC.localDescription;
          if (!localDescription) {
            throw new Error("missing local WebRTC answer");
          }
          send("sdp-answer", localDescription.toJSON() as unknown as Record<string, unknown>);
        } else if (message.type === "ice-candidate") {
          await activePC.addIceCandidate(message.payload as RTCIceCandidateInit);
        } else if (message.type === "viewport-metadata") {
          const nextSize = parseViewportMetadata(message.payload);
          if (nextSize) {
            setSize(nextSize);
          }
        } else if (message.type === "producer-health") {
          const status = parseProducerStatus(message.payload);
          if (status === "failed") {
            fail("WebRTC producer failed");
          }
        }
      } catch (cause) {
        fail(cause instanceof Error ? cause.message : "WebRTC negotiation failed");
      }
    }

    return () => {
      closed = true;
      window.clearTimeout(timeout);
      activeSocket.close();
      void activePC.close();
    };
  }, [enabled, sessionId, credentials]);

  return { phase, stream, size, error };
}

function buildSignalURL(sessionId: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/webrtc/${encodeURIComponent(sessionId)}/signal?role=viewer`;
}

function buildSignalProtocols(credentials: ApiCredentials): string[] {
  const protocols = [SIGNAL_PROTOCOL, `authorization.bearer.${credentials.token.trim()}`];
  const tenantId = resolveTenantHeader(credentials, "tenant-scoped");
  if (tenantId) {
    protocols.push(`x-aperture-tenant-id.${tenantId}`);
  }
  return protocols;
}

function parseViewportMetadata(payload: unknown): WebRTCMediaSize | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const values = payload as Partial<WebRTCMediaSize>;
  if (typeof values.width !== "number" || typeof values.height !== "number") {
    return null;
  }
  if (values.width < 1 || values.height < 1) {
    return null;
  }
  return { width: Math.round(values.width), height: Math.round(values.height) };
}

function parseProducerStatus(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const values = payload as { status?: unknown };
  return typeof values.status === "string" ? values.status : null;
}
