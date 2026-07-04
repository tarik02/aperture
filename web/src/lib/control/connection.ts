import { resolveTenantHeader, type ApiCredentials } from "#/lib/api/client.ts";
import type {
  ClientMessage,
  ControlError,
  ControlTarget,
  ScreencastFrame,
} from "#/lib/control/messages.ts";
import { parseServerMessage } from "#/lib/control/messages.ts";

export type ControlConnectionCallbacks = {
  onPhaseChange?: (phase: "connecting" | "connected" | "disconnected" | "error") => void;
  onTargetsSnapshot?: (activeTargetId: string | undefined, targets: ControlTarget[]) => void;
  onTargetChanged?: (change: string, target: ControlTarget) => void;
  onScreencastFrame?: (frame: ScreencastFrame) => void;
  onScreencastStopped?: (targetId?: string) => void;
  onError?: (error: ControlError) => void;
};

export function buildControlWebSocket(
  sessionId: string,
  credentials: ApiCredentials,
): { url: string; protocols: string[] } {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${window.location.host}/api/control/${encodeURIComponent(sessionId)}`;
  const protocols = [`authorization.bearer.${credentials.token.trim()}`];
  const tenantId = resolveTenantHeader(credentials, "tenant-scoped");
  if (tenantId) {
    protocols.push(`x-aperture-tenant-id.${tenantId}`);
  }
  return { url, protocols };
}

export class BrowserControlConnection {
  private socket: WebSocket | null = null;
  private callbacks: ControlConnectionCallbacks;
  private closed = false;

  constructor(callbacks: ControlConnectionCallbacks) {
    this.callbacks = callbacks;
  }

  connect(sessionId: string, credentials: ApiCredentials) {
    this.close();
    this.closed = false;
    this.callbacks.onPhaseChange?.("connecting");

    const { url, protocols } = buildControlWebSocket(sessionId, credentials);
    const socket = new WebSocket(url, protocols);
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (this.closed || this.socket !== socket) {
        return;
      }
      this.callbacks.onPhaseChange?.("connected");
    });

    socket.addEventListener("message", (event) => {
      if (this.closed || this.socket !== socket) {
        return;
      }
      this.handleMessage(event.data);
    });

    socket.addEventListener("close", () => {
      if (this.closed || this.socket !== socket) {
        return;
      }
      this.socket = null;
      this.callbacks.onPhaseChange?.("disconnected");
    });

    socket.addEventListener("error", () => {
      if (this.closed || this.socket !== socket) {
        return;
      }
      this.callbacks.onPhaseChange?.("error");
    });
  }

  send(message: ClientMessage) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.socket.send(JSON.stringify(message));
    return true;
  }

  close() {
    this.closed = true;
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      socket.close();
    }
  }

  isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private handleMessage(raw: unknown) {
    let parsed: unknown;
    try {
      parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      return;
    }

    const message = parseServerMessage(parsed);
    if (!message) {
      return;
    }

    switch (message.type) {
      case "targets.snapshot":
        this.callbacks.onTargetsSnapshot?.(message.activeTargetId, message.targets);
        break;
      case "target.changed":
        this.callbacks.onTargetChanged?.(message.change, message.target);
        break;
      case "screencast.frame":
        this.callbacks.onScreencastFrame?.({
          targetId: message.targetId,
          frameId: message.frameId,
          format: message.format,
          data: message.data,
          width: message.width,
          height: message.height,
          deviceScaleFactor: message.deviceScaleFactor,
          scrollOffsetX: message.scrollOffsetX,
          scrollOffsetY: message.scrollOffsetY,
          timestamp: message.timestamp,
          receivedAt: Date.now(),
        });
        break;
      case "screencast.stopped":
        this.callbacks.onScreencastStopped?.(message.targetId);
        break;
      case "error":
        this.callbacks.onError?.({ code: message.code, message: message.message });
        break;
      default:
        break;
    }
  }
}
