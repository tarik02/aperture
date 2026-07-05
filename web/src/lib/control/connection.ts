import { resolveTenantHeader, TENANT_HEADER, type ApiCredentials } from "#/lib/api/client.ts";
import type {
  ClientMessage,
  ControlError,
  ControlTarget,
  ScreencastFormat,
  ScreencastFrame,
} from "#/lib/control/messages.ts";
import { windowsVirtualKeyCodeForCodeOrKey } from "#/lib/control/keyboard.ts";
import type Protocol from "devtools-protocol";
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping";
import { z } from "zod";

export type ControlConnectionCallbacks = {
  onPhaseChange?: (phase: "connecting" | "connected" | "disconnected" | "error") => void;
  onTargetsSnapshot?: (activeTargetId: string | undefined, targets: ControlTarget[]) => void;
  onTargetChanged?: (change: string, target: ControlTarget) => void;
  onScreencastFrame?: (frame: ScreencastFrame) => void;
  onScreencastStopped?: (targetId?: string) => void;
  onError?: (error: ControlError) => void;
};

type CdpCommandMethod = Extract<keyof ProtocolMapping.Commands, string>;

type CdpCommandParams<M extends CdpCommandMethod> =
  ProtocolMapping.Commands[M]["paramsType"] extends []
    ? undefined
    : ProtocolMapping.Commands[M]["paramsType"][0];

type CdpResponse = {
  id?: number;
  method?: string;
  sessionId?: Protocol.Target.SessionID;
  params?: unknown;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
};

type CdpTarget = {
  id: Protocol.Target.TargetID;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
};

type CdpVersion = {
  webSocketDebuggerUrl: string;
};

const cdpResponseSchema: z.ZodType<CdpResponse> = z.object({
  id: z.number().optional(),
  method: z.string().optional(),
  sessionId: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
    })
    .optional(),
});

const cdpTargetSchema: z.ZodType<CdpTarget> = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  url: z.string(),
  webSocketDebuggerUrl: z.string().optional(),
});

const cdpTargetsSchema: z.ZodType<CdpTarget[]> = z.array(cdpTargetSchema);

const cdpVersionSchema: z.ZodType<CdpVersion> = z.object({
  webSocketDebuggerUrl: z.string(),
});

const createTargetResultSchema: z.ZodType<Protocol.Target.CreateTargetResponse> = z.object({
  targetId: z.string(),
});

const attachTargetResultSchema: z.ZodType<Protocol.Target.AttachToTargetResponse> = z.object({
  sessionId: z.string(),
});

const screencastFrameParamsSchema: z.ZodType<Protocol.Page.ScreencastFrameEvent> = z.object({
  data: z.string(),
  sessionId: z.number(),
  metadata: z.object({
    offsetTop: z.number(),
    deviceWidth: z.number(),
    deviceHeight: z.number(),
    pageScaleFactor: z.number(),
    scrollOffsetX: z.number(),
    scrollOffsetY: z.number(),
    timestamp: z.number().optional(),
  }),
});

const CDP_CALL_TIMEOUT_MS = 5000;

function buildCdpWebSocket(
  sessionId: string,
  rawWebSocketUrl: string,
  credentials: ApiCredentials,
): { url: string; protocols: string[] } {
  const source = new URL(rawWebSocketUrl);
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${window.location.host}/api/cdp/${encodeURIComponent(sessionId)}${source.pathname}${source.search}`;
  const protocols = ["aperture-cdp.v1", `authorization.bearer.${credentials.token.trim()}`];
  const tenantId = resolveTenantHeader(credentials, "tenant-scoped");
  if (tenantId) {
    protocols.push(`x-aperture-tenant-id.${tenantId}`);
  }
  return { url, protocols };
}

function buildCdpHeaders(credentials: ApiCredentials): Headers {
  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${credentials.token.trim()}`,
  });
  const tenantId = resolveTenantHeader(credentials, "tenant-scoped");
  if (tenantId) {
    headers.set(TENANT_HEADER, tenantId);
  }
  return headers;
}

function timeoutError(method: string): Error {
  return new Error(`${method} timed out`);
}

async function fetchCdpJSON<T>(
  sessionId: string,
  credentials: ApiCredentials,
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await fetch(`/api/cdp/${encodeURIComponent(sessionId)}${path}`, {
    headers: buildCdpHeaders(credentials),
  });
  if (!response.ok) {
    throw new Error(`CDP request failed: ${response.status}`);
  }
  const body: unknown = await response.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new Error("CDP response shape is invalid");
  }
  return parsed.data;
}

class CdpSocket {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();

  onEvent?: (method: string, params: unknown, sessionId?: Protocol.Target.SessionID) => void;
  onClose?: () => void;

  constructor(
    private readonly url: string,
    private readonly protocols: string[],
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url, this.protocols);
      let settled = false;
      this.socket = socket;

      socket.addEventListener(
        "open",
        () => {
          settled = true;
          resolve();
        },
        { once: true },
      );

      socket.addEventListener("message", (event) => {
        this.handleMessage(event.data);
      });

      socket.addEventListener("close", () => {
        this.rejectPending(new Error("CDP socket closed"));
        this.onClose?.();
      });

      socket.addEventListener(
        "error",
        () => {
          if (!settled) {
            settled = true;
            reject(new Error("CDP socket failed"));
          }
        },
        { once: true },
      );
    });
  }

  call<M extends CdpCommandMethod>(
    method: M,
    params?: CdpCommandParams<M>,
    sessionId?: Protocol.Target.SessionID,
  ): Promise<unknown> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP socket is not open"));
    }

    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const payload = { id, method, params, sessionId };
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(timeoutError(method));
      }, CDP_CALL_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => {
          window.clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          window.clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.socket?.send(JSON.stringify(payload));
      } catch (error) {
        this.pending.delete(id);
        window.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("CDP socket send failed"));
      }
    });
  }

  fire<M extends CdpCommandMethod>(
    method: M,
    params?: CdpCommandParams<M>,
    sessionId?: Protocol.Target.SessionID,
  ): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    const id = this.nextId++;
    try {
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
      return true;
    } catch {
      return false;
    }
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    this.rejectPending(new Error("CDP socket closed"));
    socket?.close();
  }

  isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private handleMessage(raw: unknown) {
    if (typeof raw !== "string") {
      return;
    }

    let parsedJSON: unknown;
    try {
      parsedJSON = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = cdpResponseSchema.safeParse(parsedJSON);
    if (!parsed.success) {
      return;
    }

    const message = parsed.data;
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      this.onEvent?.(message.method, message.params ?? {}, message.sessionId);
    }
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export class BrowserControlConnection {
  private callbacks: ControlConnectionCallbacks;
  private closed = false;
  private sessionId: string | null = null;
  private credentials: ApiCredentials | null = null;
  private browser: CdpSocket | null = null;
  private pageTargetId: Protocol.Target.TargetID | null = null;
  private pageSessionId: Protocol.Target.SessionID | null = null;
  private activeTargetId: Protocol.Target.TargetID | null = null;
  private targets: ControlTarget[] = [];
  private loadingTargetIds = new Set<string>();
  private activeSyncTimer: ReturnType<typeof setInterval> | null = null;
  private screencastStarting = false;
  private screencastFormat: ScreencastFormat = "jpeg";

  constructor(callbacks: ControlConnectionCallbacks) {
    this.callbacks = callbacks;
  }

  connect(sessionId: string, credentials: ApiCredentials) {
    this.close();
    this.closed = false;
    this.sessionId = sessionId;
    this.credentials = credentials;
    this.callbacks.onPhaseChange?.("connecting");
    void this.openBrowserSocket();
  }

  send(message: ClientMessage) {
    if (this.closed) {
      return false;
    }

    void this.dispatch(message).catch((error: unknown) => {
      this.callbacks.onError?.({
        code: "browser_control_failed",
        message: error instanceof Error ? error.message : "browser control failed",
      });
    });
    return true;
  }

  close() {
    this.closed = true;
    this.browser?.close();
    this.browser = null;
    this.pageTargetId = null;
    this.pageSessionId = null;
    this.activeTargetId = null;
    this.targets = [];
    this.loadingTargetIds.clear();
    this.screencastStarting = false;
    this.screencastFormat = "jpeg";
    this.stopActiveTargetSync();
  }

  isOpen(): boolean {
    return this.browser?.isOpen() ?? false;
  }

  private async openBrowserSocket() {
    if (!this.sessionId || !this.credentials) {
      return;
    }

    try {
      const version = await fetchCdpJSON(
        this.sessionId,
        this.credentials,
        "/json/version",
        cdpVersionSchema,
      );
      const { url, protocols } = buildCdpWebSocket(
        this.sessionId,
        version.webSocketDebuggerUrl,
        this.credentials,
      );
      if (this.closed) {
        return;
      }

      const browser = new CdpSocket(url, protocols);
      this.browser = browser;
      browser.onEvent = (method, params, sessionId) => {
        if (method.startsWith("Target.")) {
          void this.refreshTargets().catch((error: unknown) => {
            this.emitError(error);
          });
        }
        if (method === "Page.screencastFrame" && sessionId === this.pageSessionId) {
          this.handleScreencastFrame(params);
        }
        if (
          (method === "Page.frameStartedLoading" || method === "Page.frameStartedNavigating") &&
          sessionId === this.pageSessionId &&
          this.pageTargetId
        ) {
          this.setTargetLoading(this.pageTargetId, true);
        }
        if (
          (method === "Page.frameStoppedLoading" || method === "Page.loadEventFired") &&
          sessionId === this.pageSessionId &&
          this.pageTargetId
        ) {
          this.setTargetLoading(this.pageTargetId, false);
        }
        if (
          (method === "Page.frameNavigated" || method === "Page.navigatedWithinDocument") &&
          sessionId === this.pageSessionId
        ) {
          void this.refreshTargets().catch((error: unknown) => {
            this.emitError(error);
          });
        }
      };
      browser.onClose = () => {
        this.stopActiveTargetSync();
        if (!this.closed) {
          this.callbacks.onPhaseChange?.("disconnected");
        }
      };

      await browser.connect();
      if (this.closed || this.browser !== browser) {
        browser.close();
        return;
      }

      await browser.call("Target.setDiscoverTargets", { discover: true });
      this.callbacks.onPhaseChange?.("connected");
      await this.refreshTargets();
      this.startActiveTargetSync();
    } catch (error) {
      if (!this.closed) {
        this.stopActiveTargetSync();
        this.callbacks.onPhaseChange?.("error");
        this.emitError(error);
      }
    }
  }

  private async dispatch(message: ClientMessage) {
    switch (message.type) {
      case "targets.list":
        await this.refreshTargets();
        break;
      case "targets.activate":
        await this.browserSocket().call("Target.activateTarget", { targetId: message.targetId });
        this.activeTargetId = message.targetId;
        await this.refreshTargets();
        break;
      case "targets.create": {
        const result = await this.browserSocket().call("Target.createTarget", {
          url: message.url ?? "about:blank",
        });
        this.activeTargetId = createTargetResultSchema.parse(result).targetId;
        await this.refreshTargets();
        break;
      }
      case "targets.close":
        if (this.pageTargetId === message.targetId) {
          await this.stopScreencast();
        }
        await this.browserSocket().call("Target.closeTarget", { targetId: message.targetId });
        if (this.activeTargetId === message.targetId) {
          this.activeTargetId = null;
        }
        await this.refreshTargets();
        break;
      case "screencast.start":
        await this.startScreencast(message.targetId, {
          format: message.format ?? "jpeg",
          quality: message.quality ?? 80,
          maxWidth: message.maxWidth,
          maxHeight: message.maxHeight,
        });
        break;
      case "screencast.stop":
        await this.stopScreencast();
        break;
      case "page.navigate":
        this.setTargetLoading(message.targetId, true);
        await this.replaceTarget(message.targetId, message.url);
        setTimeout(() => {
          void this.refreshTargets().catch((error: unknown) => {
            this.emitError(error);
          });
        }, 500);
        break;
      case "page.reload":
        this.setTargetLoading(message.targetId, true);
        await this.withTarget(message.targetId, (socket, sessionId) =>
          socket.call("Page.reload", undefined, sessionId),
        );
        setTimeout(() => {
          void this.refreshTargets().catch((error: unknown) => {
            this.emitError(error);
          });
        }, 500);
        break;
      case "page.stopLoading":
        await this.withTarget(message.targetId, (socket, sessionId) =>
          socket.fire("Page.stopLoading", undefined, sessionId),
        );
        this.setTargetLoading(message.targetId, false);
        break;
      case "viewport.set":
        await this.withTarget(message.targetId, (socket, sessionId) =>
          socket.fire(
            "Emulation.setDeviceMetricsOverride",
            {
              width: message.width,
              height: message.height,
              deviceScaleFactor: message.deviceScaleFactor ?? 1,
              mobile: false,
            },
            sessionId,
          ),
        );
        break;
      case "input.mouse":
        await this.dispatchMouse(message);
        break;
      case "input.wheel":
        await this.withTarget(message.targetId, (socket, sessionId) =>
          socket.fire(
            "Input.dispatchMouseEvent",
            {
              type: "mouseWheel",
              x: message.x,
              y: message.y,
              button: "none",
              buttons: 0,
              deltaX: message.deltaX,
              deltaY: message.deltaY,
              modifiers: message.modifiers ?? 0,
            },
            sessionId,
          ),
        );
        break;
      case "input.key":
        await this.dispatchKey(message);
        break;
      case "clipboard.copy":
        await this.dispatchShortcut(message.targetId, "c", "KeyC");
        break;
      case "clipboard.cut":
        await this.dispatchShortcut(message.targetId, "x", "KeyX");
        break;
      case "clipboard.paste": {
        const item = message.items.find((entry) => entry.mimeType === "text/plain");
        if (item) {
          await this.withTarget(message.targetId, (socket, sessionId) =>
            socket.fire("Input.insertText", { text: item.data }, sessionId),
          );
        }
        break;
      }
      default: {
        const exhaustive: never = message;
        return exhaustive;
      }
    }
  }

  private async refreshTargets() {
    if (!this.sessionId || !this.credentials || this.closed) {
      return;
    }

    const rawTargets = await fetchCdpJSON(
      this.sessionId,
      this.credentials,
      "/json/list",
      cdpTargetsSchema,
    );
    if (this.closed) {
      return;
    }
    const pageTargets = rawTargets.filter(
      (target) => target.type === "page" || target.type === "webview",
    );

    if (!this.activeTargetId || !pageTargets.some((target) => target.id === this.activeTargetId)) {
      this.activeTargetId = pageTargets[0]?.id ?? null;
    }

    this.targets = pageTargets.map((target) => ({
      id: target.id,
      type: target.type,
      title: target.title,
      url: target.url,
      attached: target.id === this.pageTargetId,
      loading: this.loadingTargetIds.has(target.id),
    }));

    this.emitTargetsSnapshot();
  }

  private emitTargetsSnapshot() {
    this.callbacks.onTargetsSnapshot?.(this.activeTargetId ?? undefined, this.targets);
  }

  private setTargetLoading(targetId: string, loading: boolean) {
    if (loading) {
      this.loadingTargetIds.add(targetId);
    } else {
      this.loadingTargetIds.delete(targetId);
    }
    this.targets = this.targets.map((target) =>
      target.id === targetId ? { ...target, loading } : target,
    );
    this.emitTargetsSnapshot();
  }

  private startActiveTargetSync() {
    this.stopActiveTargetSync();
    this.activeSyncTimer = setInterval(() => {
      void this.refreshTargets().catch((error: unknown) => {
        this.emitError(error);
      });
    }, 750);
  }

  private stopActiveTargetSync() {
    if (this.activeSyncTimer) {
      clearInterval(this.activeSyncTimer);
    }
    this.activeSyncTimer = null;
  }

  private async startScreencast(
    targetId: string | undefined,
    options: {
      format: ScreencastFormat;
      quality: number;
      maxWidth?: number;
      maxHeight?: number;
    },
  ) {
    const resolvedTargetId = targetId ?? this.activeTargetId;
    if (!resolvedTargetId || this.screencastStarting) {
      return;
    }

    this.screencastStarting = true;

    try {
      await this.stopScreencast();
      await this.browserSocket().call("Target.activateTarget", { targetId: resolvedTargetId });
      const sessionId = await this.attachTarget(resolvedTargetId);
      this.pageTargetId = resolvedTargetId;
      this.pageSessionId = sessionId;
      this.screencastFormat = options.format;

      const params: Protocol.Page.StartScreencastRequest = {
        format: options.format,
        quality: options.quality,
      };
      if (options.maxWidth !== undefined) {
        params.maxWidth = options.maxWidth;
      }
      if (options.maxHeight !== undefined) {
        params.maxHeight = options.maxHeight;
      }

      try {
        await this.browserSocket().call("Page.enable", undefined, sessionId);
        await this.browserSocket()
          .call("Page.bringToFront", undefined, sessionId)
          .catch(() => undefined);
        await this.browserSocket().call("Page.startScreencast", params, sessionId);
      } catch (error) {
        if (this.pageSessionId === sessionId) {
          this.pageTargetId = null;
          this.pageSessionId = null;
        }
        await this.browserSocket()
          .call("Target.detachFromTarget", { sessionId })
          .catch(() => undefined);
        throw error;
      }
      await this.refreshTargets();
    } finally {
      this.screencastStarting = false;
    }
  }

  private async stopScreencast() {
    const targetId = this.pageTargetId ?? undefined;
    const sessionId = this.pageSessionId;
    this.pageTargetId = null;
    this.pageSessionId = null;
    if (sessionId && this.browser?.isOpen()) {
      this.browser.fire("Page.stopScreencast", undefined, sessionId);
      await this.browser.call("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    }
    this.callbacks.onScreencastStopped?.(targetId);
  }

  private handleScreencastFrame(params: unknown) {
    const parsed = screencastFrameParamsSchema.safeParse(params);
    if (!parsed.success) {
      return;
    }

    const { data, metadata, sessionId } = parsed.data;
    const targetId = this.pageTargetId;
    const pageSessionId = this.pageSessionId;
    if (!targetId || !pageSessionId) {
      return;
    }
    this.callbacks.onScreencastFrame?.({
      targetId,
      frameId: sessionId,
      format: this.screencastFormat,
      data,
      width: metadata.deviceWidth,
      height: metadata.deviceHeight,
      deviceScaleFactor: metadata.pageScaleFactor,
      scrollOffsetX: metadata.scrollOffsetX,
      scrollOffsetY: metadata.scrollOffsetY,
      timestamp: metadata.timestamp,
      receivedAt: Date.now(),
    });
    this.browser?.fire("Page.screencastFrameAck", { sessionId }, pageSessionId);
  }

  private async dispatchMouse(message: Extract<ClientMessage, { type: "input.mouse" }>) {
    const button = message.button ?? "left";
    const clickCount = message.clickCount ?? (message.action === "move" ? 0 : 1);
    if (message.action === "click" || message.action === "doubleClick") {
      const resolvedClickCount = message.action === "doubleClick" ? 2 : clickCount;
      await this.dispatchMouse({
        ...message,
        action: "down",
        button,
        clickCount: resolvedClickCount,
      });
      await this.dispatchMouse({
        ...message,
        action: "up",
        button,
        clickCount: resolvedClickCount,
      });
      return;
    }

    const type =
      message.action === "move"
        ? "mouseMoved"
        : message.action === "down"
          ? "mousePressed"
          : "mouseReleased";
    const eventButton = message.action === "move" && (message.buttons ?? 0) === 0 ? "none" : button;
    await this.withTarget(message.targetId, (socket, sessionId) =>
      socket.fire(
        "Input.dispatchMouseEvent",
        {
          type,
          x: message.x,
          y: message.y,
          button: eventButton,
          buttons:
            message.buttons ?? (message.action === "move" ? 0 : mouseButtonsForButton(button)),
          clickCount,
          modifiers: message.modifiers ?? 0,
        },
        sessionId,
      ),
    );
  }

  private async dispatchKey(message: Extract<ClientMessage, { type: "input.key" }>) {
    const type: Protocol.Input.DispatchKeyEventRequest["type"] =
      message.action === "char"
        ? "char"
        : message.action === "up"
          ? "keyUp"
          : message.text !== undefined
            ? "keyDown"
            : "rawKeyDown";
    const virtualKeyCode =
      message.windowsVirtualKeyCode ?? windowsVirtualKeyCodeForCodeOrKey(message.code, message.key);
    const params: Protocol.Input.DispatchKeyEventRequest = {
      type,
      modifiers: message.modifiers ?? 0,
      windowsVirtualKeyCode: virtualKeyCode,
      nativeVirtualKeyCode: message.nativeVirtualKeyCode ?? virtualKeyCode,
    };
    if (message.key !== undefined) {
      params.key = message.key;
    }
    if (message.code !== undefined) {
      params.code = message.code;
    }
    if (message.text !== undefined) {
      params.text = message.text;
    }
    if (message.unmodifiedText !== undefined) {
      params.unmodifiedText = message.unmodifiedText;
    }
    if (message.location !== undefined) {
      params.location = message.location;
    }
    if (message.autoRepeat !== undefined) {
      params.autoRepeat = message.autoRepeat;
    }
    if (message.isKeypad !== undefined) {
      params.isKeypad = message.isKeypad;
    }
    await this.withTarget(message.targetId, (socket, sessionId) =>
      socket.fire("Input.dispatchKeyEvent", params, sessionId),
    );
  }

  private async dispatchShortcut(targetId: string, key: string, code: string) {
    await this.dispatchKey({
      type: "input.key",
      targetId,
      action: "down",
      key: "Control",
      code: "ControlLeft",
      modifiers: 2,
    });
    await this.dispatchKey({
      type: "input.key",
      targetId,
      action: "down",
      key,
      code,
      modifiers: 2,
    });
    await this.dispatchKey({ type: "input.key", targetId, action: "up", key, code, modifiers: 2 });
    await this.dispatchKey({
      type: "input.key",
      targetId,
      action: "up",
      key: "Control",
      code: "ControlLeft",
    });
  }

  private async withTarget<T>(
    targetId: string,
    action: (socket: CdpSocket, sessionId: string) => Promise<T> | T,
  ) {
    if (this.browser?.isOpen() && this.pageTargetId === targetId && this.pageSessionId) {
      return action(this.browser, this.pageSessionId);
    }

    const browser = this.browserSocket();
    const sessionId = await this.attachTarget(targetId);
    try {
      return await action(browser, sessionId);
    } finally {
      await browser.call("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    }
  }

  private async attachTarget(targetId: string): Promise<string> {
    const result = await this.browserSocket().call("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    return attachTargetResultSchema.parse(result).sessionId;
  }

  private browserSocket(): CdpSocket {
    if (!this.browser?.isOpen()) {
      throw new Error("CDP browser socket is not open");
    }
    return this.browser;
  }

  private emitError(error: unknown) {
    this.callbacks.onError?.({
      code: "browser_control_failed",
      message: error instanceof Error ? error.message : "browser control failed",
    });
  }

  private async replaceTarget(oldTargetId: string, url: string) {
    const result = await this.browserSocket().call("Target.createTarget", { url });
    const nextTargetId = createTargetResultSchema.parse(result).targetId;
    this.activeTargetId = nextTargetId;
    this.loadingTargetIds.add(nextTargetId);
    await this.browserSocket().call("Target.activateTarget", { targetId: nextTargetId });
    if (this.pageTargetId === oldTargetId) {
      await this.stopScreencast();
    }
    await this.browserSocket()
      .call("Target.closeTarget", { targetId: oldTargetId })
      .catch(() => undefined);
    await this.refreshTargets();
  }
}

function mouseButtonsForButton(button: "left" | "middle" | "right" | "none"): number {
  switch (button) {
    case "left":
      return 1;
    case "right":
      return 2;
    case "middle":
      return 4;
    case "none":
      return 0;
    default: {
      const exhaustive: never = button;
      return exhaustive;
    }
  }
}
