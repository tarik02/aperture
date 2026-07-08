import { apiClient, type ApiCredentials } from "#/lib/api/client.ts";
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
import { Observable, Subject, Subscription, timer } from "rxjs";
import { webSocket, type WebSocketSubject } from "rxjs/webSocket";
import { z } from "zod";

export type ControlConnectionCallbacks = {
  onPhaseChange?: (phase: "connecting" | "connected" | "disconnected" | "error") => void;
  onTargetsSnapshot?: (activeTargetId: string | undefined, targets: ControlTarget[]) => void;
  onTargetChanged?: (change: string, target: ControlTarget) => void;
  onScreencastFrame?: (frame: ScreencastFrame) => void;
  onScreencastStopped?: (targetId?: string) => void;
  onError?: (error: ControlError) => void;
};

export type ControlConnectionEvent =
  | { type: "phase"; phase: "connecting" | "connected" | "disconnected" | "error" }
  | { type: "targets-snapshot"; activeTargetId: string | undefined; targets: ControlTarget[] }
  | { type: "target-changed"; change: string; target: ControlTarget }
  | { type: "screencast-frame"; frame: ScreencastFrame }
  | { type: "screencast-stopped"; targetId?: string }
  | { type: "error"; error: ControlError };

export type BrowserControlConnectionOptions = {
  sessionId: string;
  credentials: ApiCredentials;
  input$: Observable<ClientMessage>;
};

type CdpCommandMethod = Extract<keyof ProtocolMapping.Commands, string>;

type CdpCommandParams<M extends CdpCommandMethod> =
  ProtocolMapping.Commands[M]["paramsType"] extends []
    ? undefined
    : ProtocolMapping.Commands[M]["paramsType"][0];
type CdpCommandReturn<M extends CdpCommandMethod> = ProtocolMapping.Commands[M]["returnType"];

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

type CdpProtocolEvent = {
  method: string;
  params: unknown;
  sessionId?: Protocol.Target.SessionID;
};

type CdpSocket = {
  opened: Promise<void>;
  events$: Observable<CdpProtocolEvent>;
  closed$: Observable<void>;
  call: <M extends CdpCommandMethod>(
    method: M,
    params?: CdpCommandParams<M>,
    sessionId?: Protocol.Target.SessionID,
  ) => Promise<unknown>;
  fire: <M extends CdpCommandMethod>(
    method: M,
    params?: CdpCommandParams<M>,
    sessionId?: Protocol.Target.SessionID,
  ) => boolean;
  close: () => void;
  isOpen: () => boolean;
};

type CdpTargetInfo = Pick<
  Protocol.Target.TargetInfo,
  "targetId" | "type" | "title" | "url" | "attached"
>;

type CdpGetTargetsResponse = {
  targetInfos: CdpTargetInfo[];
};

type CdpVersion = {
  webSocketDebuggerUrl: string;
};

const cdpTargetInfoSchema: z.ZodType<CdpTargetInfo> = z.object({
  targetId: z.string(),
  type: z.string(),
  title: z.string(),
  url: z.string(),
  attached: z.boolean(),
});

const getTargetsResultSchema: z.ZodType<CdpGetTargetsResponse> = z.object({
  targetInfos: z.array(cdpTargetInfoSchema),
});

const targetInfoEventParamsSchema = z.object({
  targetInfo: cdpTargetInfoSchema,
});

const targetDestroyedEventParamsSchema = z.object({
  targetId: z.string(),
});

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
const CDP_CONNECT_RETRY_MS = 500;
const CDP_CONNECT_TIMEOUT_MS = 30_000;

function buildCdpWebSocket(rawWebSocketUrl: string): { url: string; protocols: string[] } {
  const source = new URL(rawWebSocketUrl, window.location.origin);
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  source.protocol = protocol;
  source.host = window.location.host;
  source.hash = "";
  return {
    url: source.toString(),
    protocols: [],
  };
}

function timeoutError(method: string): Error {
  return new Error(`${method} timed out`);
}

async function fetchCdpJSON<T>(
  sessionId: string,
  cdpToken: string,
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await fetch(
    `/sessions/${encodeURIComponent(sessionId)}/cdp/${encodeURIComponent(cdpToken)}${path}`,
    {
      headers: {
        Accept: "application/json",
      },
    },
  );
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

function cdpSocket(url: string, protocols: string[]): CdpSocket {
  let open = false;
  let closed = false;
  let nextId = 1;
  let resolveOpened: () => void = () => undefined;
  let rejectOpened: (error: Error) => void = () => undefined;
  let openSettled = false;
  const events$ = new Subject<CdpProtocolEvent>();
  const closed$ = new Subject<void>();
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: Subscription;
    }
  >();
  const opened = new Promise<void>((resolve, reject) => {
    resolveOpened = resolve;
    rejectOpened = reject;
  });
  const socket: WebSocketSubject<unknown> = webSocket<unknown>({
    url,
    protocol: protocols,
    serializer: (frame) => JSON.stringify(frame),
    deserializer: (event) => parseCdpSocketFrame(event.data),
    openObserver: {
      next: () => {
        open = true;
        openSettled = true;
        resolveOpened();
      },
    },
    closeObserver: {
      next: () => {
        open = false;
        rejectPending(pending, new Error("CDP socket closed"));
        if (!openSettled) {
          openSettled = true;
          rejectOpened(new Error("CDP socket failed"));
        }
        if (!closed) {
          closed$.next();
        }
      },
    },
  });
  const subscription = socket.subscribe({
    next: (message) => {
      const parsed = cdpResponseSchema.safeParse(message);
      if (!parsed.success) {
        return;
      }
      const frame = parsed.data;
      if (frame.id !== undefined) {
        const match = pending.get(frame.id);
        if (!match) {
          return;
        }
        pending.delete(frame.id);
        match.timeout.unsubscribe();
        if (frame.error) {
          match.reject(new Error(frame.error.message));
        } else {
          match.resolve(frame.result);
        }
        return;
      }

      if (frame.method) {
        events$.next({
          method: frame.method,
          params: frame.params ?? {},
          sessionId: frame.sessionId,
        });
      }
    },
    error: () => {
      open = false;
      rejectPending(pending, new Error("CDP socket failed"));
      if (!openSettled) {
        openSettled = true;
        rejectOpened(new Error("CDP socket failed"));
      }
      if (!closed) {
        closed$.next();
      }
    },
  });
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    open = false;
    rejectPending(pending, new Error("CDP socket closed"));
    if (!openSettled) {
      openSettled = true;
      rejectOpened(new Error("CDP socket closed"));
    }
    socket.complete();
    subscription.unsubscribe();
    events$.complete();
    closed$.complete();
  };

  return {
    opened,
    events$: events$.asObservable(),
    closed$: closed$.asObservable(),
    call: (method, params, sessionId) => {
      if (!open) {
        return Promise.reject(new Error("CDP socket is not open"));
      }

      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timeout = timer(CDP_CALL_TIMEOUT_MS).subscribe(() => {
          pending.delete(id);
          reject(timeoutError(method));
        });
        pending.set(id, { resolve, reject, timeout });
        try {
          socket.next({ id, method, params, sessionId });
        } catch (cause) {
          pending.delete(id);
          timeout.unsubscribe();
          reject(cause instanceof Error ? cause : new Error("CDP socket send failed"));
        }
      });
    },
    fire: (method, params, sessionId) => {
      if (!open) {
        return false;
      }
      try {
        socket.next({ id: nextId++, method, params, sessionId });
        return true;
      } catch {
        return false;
      }
    },
    close,
    isOpen: () => open,
  };
}

function parseCdpSocketFrame(data: unknown): CdpResponse {
  const text = z.string().parse(data);
  const json: unknown = JSON.parse(text);
  return cdpResponseSchema.parse(json);
}

function rejectPending(
  pending: Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: Subscription;
    }
  >,
  error: Error,
) {
  for (const match of pending.values()) {
    match.timeout.unsubscribe();
    match.reject(error);
  }
  pending.clear();
}

export function browserControlConnection$(
  options: BrowserControlConnectionOptions,
): Observable<ControlConnectionEvent> {
  return new Observable<ControlConnectionEvent>((subscriber) => {
    const connection = new BrowserControlConnectionRuntime({
      onPhaseChange: (phase) => subscriber.next({ type: "phase", phase }),
      onTargetsSnapshot: (activeTargetId, targets) =>
        subscriber.next({ type: "targets-snapshot", activeTargetId, targets }),
      onTargetChanged: (change, target) =>
        subscriber.next({ type: "target-changed", change, target }),
      onScreencastFrame: (frame) => subscriber.next({ type: "screencast-frame", frame }),
      onScreencastStopped: (targetId) => subscriber.next({ type: "screencast-stopped", targetId }),
      onError: (error) => subscriber.next({ type: "error", error }),
    });
    const inputSubscription = options.input$.subscribe({
      next: (message) => connection.send(message),
      error: (cause) => subscriber.error(cause),
    });

    connection.connect(options.sessionId, options.credentials);

    return () => {
      inputSubscription.unsubscribe();
      connection.close();
    };
  });
}

class BrowserControlConnectionRuntime {
  private callbacks: ControlConnectionCallbacks;
  private closed = false;
  private sessionId: string | null = null;
  private credentials: ApiCredentials | null = null;
  private cdpToken: string | null = null;
  private browser: CdpSocket | null = null;
  private pageTargetId: Protocol.Target.TargetID | null = null;
  private pageSessionId: Protocol.Target.SessionID | null = null;
  private activeTargetId: Protocol.Target.TargetID | null = null;
  private targets: ControlTarget[] = [];
  private loadingTargetIds = new Set<string>();
  private screencastStarting = false;
  private screencastFormat: ScreencastFormat = "jpeg";
  private connectStartedAt = 0;
  private connectRetrySubscription = new Subscription();
  private delayedRefreshes = new Subscription();

  constructor(callbacks: ControlConnectionCallbacks) {
    this.callbacks = callbacks;
  }

  connect(sessionId: string, credentials: ApiCredentials) {
    this.close();
    this.closed = false;
    this.sessionId = sessionId;
    this.credentials = credentials;
    this.cdpToken = null;
    this.connectStartedAt = Date.now();
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
    this.connectRetrySubscription.unsubscribe();
    this.connectRetrySubscription = new Subscription();
    this.delayedRefreshes.unsubscribe();
    this.delayedRefreshes = new Subscription();
    this.browser?.close();
    this.browser = null;
    this.cdpToken = null;
    this.pageTargetId = null;
    this.pageSessionId = null;
    this.activeTargetId = null;
    this.targets = [];
    this.loadingTargetIds.clear();
    this.screencastStarting = false;
    this.screencastFormat = "jpeg";
  }

  isOpen(): boolean {
    return this.browser?.isOpen() ?? false;
  }

  private async openBrowserSocket() {
    if (!this.sessionId || !this.credentials) {
      return;
    }

    let browser: CdpSocket | null = null;
    try {
      const cdpToken = await this.currentCDPToken();
      const version = await fetchCdpJSON(
        this.sessionId,
        cdpToken,
        "/json/version",
        cdpVersionSchema,
      );
      const { url, protocols } = buildCdpWebSocket(version.webSocketDebuggerUrl);
      if (this.closed) {
        return;
      }

      browser = cdpSocket(url, protocols);
      this.browser = browser;
      browser.events$.subscribe(({ method, params, sessionId }) => {
        if (method === "Target.targetCreated" || method === "Target.targetInfoChanged") {
          this.upsertTargetFromEvent(params);
        }
        if (method === "Target.targetDestroyed") {
          this.removeTargetFromEvent(params);
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
          sessionId === this.pageSessionId &&
          this.pageTargetId
        ) {
          this.setTargetLoading(this.pageTargetId, false);
        }
      });
      browser.closed$.subscribe(() => {
        if (!this.closed) {
          this.callbacks.onPhaseChange?.("disconnected");
        }
      });

      await browser.opened;
      if (this.closed || this.browser !== browser) {
        browser.close();
        return;
      }

      await browser.call("Target.setDiscoverTargets", { discover: true });
      this.callbacks.onPhaseChange?.("connected");
      await this.refreshTargets();
    } catch (error) {
      if (browser && this.browser === browser) {
        this.browser = null;
        browser.close();
      }
      if (!this.closed) {
        if (Date.now() - this.connectStartedAt < CDP_CONNECT_TIMEOUT_MS) {
          this.callbacks.onPhaseChange?.("connecting");
          this.connectRetrySubscription.unsubscribe();
          this.connectRetrySubscription = timer(CDP_CONNECT_RETRY_MS).subscribe(() => {
            void this.openBrowserSocket();
          });
          return;
        }
        this.callbacks.onPhaseChange?.("error");
        this.emitError(error);
      }
    }
  }

  private async currentCDPToken() {
    if (this.cdpToken) {
      return this.cdpToken;
    }
    if (!this.sessionId || !this.credentials) {
      throw new Error("CDP token unavailable");
    }
    const result = await apiClient.rotateSessionCdpToken(this.credentials, this.sessionId);
    if (!result.cdpToken) {
      throw new Error("CDP token unavailable");
    }
    this.cdpToken = result.cdpToken;
    return result.cdpToken;
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
        await this.withTarget(message.targetId, (socket, sessionId) =>
          socket.call("Page.navigate", { url: message.url }, sessionId),
        );
        this.scheduleTargetsRefresh();
        break;
      case "page.historyBack":
        await this.navigateHistory(message.targetId, -1);
        break;
      case "page.historyForward":
        await this.navigateHistory(message.targetId, 1);
        break;
      case "page.reload":
        this.setTargetLoading(message.targetId, true);
        await this.withTarget(message.targetId, (socket, sessionId) =>
          socket.call("Page.reload", undefined, sessionId),
        );
        this.scheduleTargetsRefresh();
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
    if (this.closed || !this.browser?.isOpen()) {
      return;
    }

    const browser = this.browser;
    const result = getTargetsResultSchema.parse(await browser.call("Target.getTargets"));
    if (this.closed || this.browser !== browser) {
      return;
    }

    const pageTargets = result.targetInfos.filter(
      (target) => target.type === "page" || target.type === "webview",
    );

    if (
      !this.activeTargetId ||
      !pageTargets.some((target) => target.targetId === this.activeTargetId)
    ) {
      this.activeTargetId = pageTargets[0]?.targetId ?? null;
    }

    this.targets = pageTargets.map((target) => ({
      id: target.targetId,
      type: target.type,
      title: target.title,
      url: target.url,
      attached: target.targetId === this.pageTargetId,
      loading: this.loadingTargetIds.has(target.targetId),
    }));

    this.emitTargetsSnapshot();
  }

  private upsertTargetFromEvent(params: unknown) {
    if (this.closed) {
      return;
    }

    const parsed = targetInfoEventParamsSchema.safeParse(params);
    if (!parsed.success) {
      return;
    }

    const target = this.controlTargetFromInfo(parsed.data.targetInfo);
    const targetId = parsed.data.targetInfo.targetId;
    const index = this.targets.findIndex((entry) => entry.id === targetId);
    if (!target) {
      if (index !== -1) {
        const removed = this.targets[index];
        this.targets = this.targets.filter((entry) => entry.id !== targetId);
        if (this.activeTargetId === targetId) {
          this.activeTargetId = this.targets[0]?.id ?? null;
        }
        this.callbacks.onTargetChanged?.("destroyed", removed);
        this.emitTargetsSnapshot();
      }
      return;
    }

    if (index === -1) {
      this.targets = [...this.targets, target];
      this.activeTargetId = this.activeTargetId ?? target.id;
      this.emitTargetsSnapshot();
      return;
    }

    const current = this.targets[index];
    if (
      current.type === target.type &&
      current.title === target.title &&
      current.url === target.url &&
      current.attached === target.attached &&
      current.loading === target.loading
    ) {
      return;
    }

    const next = [...this.targets];
    next[index] = target;
    this.targets = next;
    this.emitTargetsSnapshot();
  }

  private removeTargetFromEvent(params: unknown) {
    if (this.closed) {
      return;
    }

    const parsed = targetDestroyedEventParamsSchema.safeParse(params);
    if (!parsed.success) {
      return;
    }

    const targetId = parsed.data.targetId;
    const target = this.targets.find((entry) => entry.id === targetId);
    if (!target) {
      return;
    }

    this.targets = this.targets.filter((entry) => entry.id !== targetId);
    this.loadingTargetIds.delete(targetId);
    if (this.activeTargetId === targetId) {
      this.activeTargetId = this.targets[0]?.id ?? null;
    }
    if (this.pageTargetId === targetId) {
      this.pageTargetId = null;
      this.pageSessionId = null;
      this.callbacks.onScreencastStopped?.(targetId);
    }
    this.callbacks.onTargetChanged?.("destroyed", target);
    this.emitTargetsSnapshot();
  }

  private controlTargetFromInfo(targetInfo: CdpTargetInfo): ControlTarget | null {
    if (targetInfo.type !== "page" && targetInfo.type !== "webview") {
      return null;
    }

    return {
      id: targetInfo.targetId,
      type: targetInfo.type,
      title: targetInfo.title,
      url: targetInfo.url,
      attached: targetInfo.targetId === this.pageTargetId,
      loading: this.loadingTargetIds.has(targetInfo.targetId),
    };
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

  private async navigateHistory(targetId: string, delta: -1 | 1) {
    await this.withTarget(targetId, async (socket, sessionId) => {
      const history = (await socket.call(
        "Page.getNavigationHistory",
        undefined,
        sessionId,
      )) as CdpCommandReturn<"Page.getNavigationHistory">;
      const nextIndex = history.currentIndex + delta;
      const entry = history.entries[nextIndex];
      if (!entry) {
        return;
      }
      this.setTargetLoading(targetId, true);
      await socket.call("Page.navigateToHistoryEntry", { entryId: entry.id }, sessionId);
      this.scheduleTargetsRefresh();
    });
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

  private scheduleTargetsRefresh() {
    this.delayedRefreshes.add(
      timer(500).subscribe(() => {
        void this.refreshTargets().catch((error: unknown) => {
          this.emitError(error);
        });
      }),
    );
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
