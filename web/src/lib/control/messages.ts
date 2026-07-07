import type Protocol from "devtools-protocol";

export type ScreencastFormat = NonNullable<Protocol.Page.StartScreencastRequest["format"]>;

export type ControlTarget = {
  id: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
  loading: boolean;
};

export type ControlConnectionPhase = "idle" | "connecting" | "connected" | "disconnected" | "error";

export type ScreencastFrame = {
  targetId: string;
  frameId: number;
  format: ScreencastFormat;
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
  | { type: "page.historyBack"; targetId: string }
  | { type: "page.historyForward"; targetId: string }
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
      format?: ScreencastFormat;
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
      buttons?: number;
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
      unmodifiedText?: string;
      modifiers?: number;
      windowsVirtualKeyCode?: number;
      nativeVirtualKeyCode?: number;
      location?: number;
      autoRepeat?: boolean;
      isKeypad?: boolean;
    }
  | { type: "clipboard.copy"; targetId: string }
  | { type: "clipboard.cut"; targetId: string }
  | { type: "clipboard.paste"; targetId: string; items: Array<{ mimeType: string; data: string }> };
