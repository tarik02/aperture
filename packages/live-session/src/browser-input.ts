export type BrowserInputMessage =
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
