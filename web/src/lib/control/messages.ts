export type ControlTarget = {
  id: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
};

export type ControlConnectionPhase = "idle" | "connecting" | "connected" | "disconnected" | "error";

export type ScreencastFrame = {
  targetId: string;
  frameId: number;
  format: string;
  data: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  scrollOffsetX: number;
  scrollOffsetY: number;
  timestamp?: number;
  receivedAt: number;
};

export type ControlError = {
  code: string;
  message: string;
};

export type ClientMessage =
  | { type: "targets.list" }
  | { type: "targets.activate"; targetId: string }
  | { type: "targets.create"; url?: string }
  | { type: "targets.close"; targetId: string }
  | { type: "page.navigate"; targetId: string; url: string }
  | { type: "page.reload"; targetId: string }
  | { type: "page.stopLoading"; targetId: string }
  | {
      type: "viewport.set";
      targetId: string;
      width: number;
      height: number;
      deviceScaleFactor?: number;
    }
  | {
      type: "screencast.start";
      targetId?: string;
      format?: string;
      quality?: number;
      maxWidth?: number;
      maxHeight?: number;
    }
  | { type: "screencast.stop" }
  | {
      type: "input.mouse";
      targetId: string;
      action: "move" | "down" | "up" | "click" | "doubleClick";
      x: number;
      y: number;
      button?: "left" | "middle" | "right" | "none";
      clickCount?: number;
      modifiers?: number;
    }
  | {
      type: "input.wheel";
      targetId: string;
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
      modifiers?: number;
    }
  | {
      type: "input.key";
      targetId: string;
      action: "down" | "up" | "char";
      key?: string;
      code?: string;
      text?: string;
      modifiers?: number;
    }
  | { type: "clipboard.copy"; targetId: string }
  | { type: "clipboard.cut"; targetId: string }
  | { type: "clipboard.paste"; targetId: string; items: Array<{ mimeType: string; data: string }> };

export type ServerMessage =
  | {
      type: "targets.snapshot";
      sessionId: string;
      activeTargetId?: string;
      targets: ControlTarget[];
    }
  | {
      type: "target.changed";
      change: string;
      target: ControlTarget;
    }
  | {
      type: "screencast.frame";
      sessionId: string;
      targetId: string;
      frameId: number;
      format: string;
      data: string;
      width: number;
      height: number;
      deviceScaleFactor: number;
      scrollOffsetX: number;
      scrollOffsetY: number;
      timestamp?: number;
    }
  | {
      type: "screencast.stopped";
      sessionId: string;
      targetId?: string;
    }
  | {
      type: "clipboard.data";
      formats?: string[];
      items?: Array<{ mimeType: string; data: string }>;
      errors?: Array<{ mimeType: string; message: string }>;
    }
  | {
      type: "error";
      code: string;
      message: string;
    };

export function parseServerMessage(data: unknown): ServerMessage | null {
  if (!data || typeof data !== "object" || !("type" in data)) {
    return null;
  }
  return data as ServerMessage;
}
