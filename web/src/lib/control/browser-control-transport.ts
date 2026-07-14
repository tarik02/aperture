import {
  EMPTY,
  Observable,
  ReplaySubject,
  Subject,
  combineLatest,
  distinctUntilChanged,
  filter,
  ignoreElements,
  map,
  merge,
  of,
  share,
  shareReplay,
  startWith,
  switchMap,
  tap,
  timer,
  withLatestFrom,
} from "rxjs";
import type { ApiCredentials } from "#/lib/api/client.ts";
import { cdpControl$, type CdpControlState } from "#/lib/control/cdp-control-transport.ts";
import type {
  ClientMessage,
  ControlConnectionPhase,
  ControlError,
  ControlTarget,
  ScreencastFrame,
} from "#/lib/control/messages.ts";
import type { ViewportPreset } from "#/lib/control/viewport.ts";
import {
  webRTCMedia$,
  webRTCMediaErrorMessage,
  type WebRTCMediaMetrics,
  type WebRTCMediaPhase,
  type WebRTCMediaSize,
  type WebRTCMediaState,
  type WebRTCStreamSettings,
  type WebRTCViewportRequest,
} from "#/lib/control/webrtc-media-transport.ts";

export type BrowserMediaPath = "cdp" | "webrtc-live" | "fallback-cdp";

export type BrowserControlState = {
  phase: ControlConnectionPhase;
  targets: ControlTarget[];
  activeTargetId: string | null;
  frame: ScreencastFrame | null;
  mediaPhase: WebRTCMediaPhase;
  mediaStream: MediaStream | null;
  mediaSize: WebRTCMediaSize | null;
  mediaStreamSettings: WebRTCStreamSettings | null;
  mediaMetrics: WebRTCMediaMetrics | null;
  mediaError: string | null;
  mediaPath: BrowserMediaPath;
  lastError: ControlError | null;
};

type ConnectOptions = {
  webrtcPreferred: boolean;
  iceServers: RTCIceServer[];
  viewport: ViewportPreset;
};

type BrowserControlOptions = ConnectOptions & {
  sessionId: string;
  sessionToken: string;
  credentials: ApiCredentials;
  input$: Observable<ClientMessage>;
  viewport$: Observable<ViewportPreset>;
  streamSettings$: Observable<WebRTCStreamSettings>;
  reconnect$: Observable<void>;
  startScreencast$: Observable<void>;
};

export type BrowserControlOutput =
  | { type: "state"; state: BrowserControlState }
  | { type: "error"; error: ControlError };

type WebRTCInputMessage =
  | Extract<ClientMessage, { type: "input.mouse" }>
  | Extract<ClientMessage, { type: "input.wheel" }>
  | Extract<ClientMessage, { type: "input.key" }>;

type ViewportCommand = Extract<ClientMessage, { type: "viewport.set" }>;

const initialMediaState: WebRTCMediaState = {
  phase: "idle",
  stream: null,
  size: null,
  streamSettings: null,
  metrics: null,
  error: null,
  inputReady: false,
};
const initialCdpState: CdpControlState = {
  phase: "idle",
  targets: [],
  activeTargetId: null,
  frame: null,
  lastError: null,
};
const WEBRTC_WHEEL_DELTA_SCALE = 0.1;

export const initialBrowserControlState: BrowserControlState = browserState(
  false,
  initialCdpState,
  initialMediaState,
);

export function browserControl$(options: BrowserControlOptions): Observable<BrowserControlOutput> {
  return new Observable<BrowserControlOutput>((subscriber) => {
    const cdpInput$ = new Subject<ClientMessage>();
    const webRTCInput$ = new Subject<WebRTCInputMessage>();
    const webRTCViewport$ = new ReplaySubject<WebRTCViewportRequest>(1);
    const webRTCStreamSettings$ = new ReplaySubject<WebRTCStreamSettings>(1);
    const viewport$ = options.viewport$.pipe(
      startWith(options.viewport),
      shareReplay({ bufferSize: 1, refCount: true }),
    );
    const cdpOutput$ = options.reconnect$.pipe(
      startWith(undefined),
      switchMap(() =>
        cdpControl$({
          sessionId: options.sessionId,
          credentials: options.credentials,
          input$: cdpInput$,
        }),
      ),
      share(),
    );
    const cdpState$ = cdpOutput$.pipe(
      filter((output) => output.type === "state"),
      map((output) => output.state),
      startWith(initialCdpState),
      shareReplay({ bufferSize: 1, refCount: true }),
    );
    const mediaActive$ = cdpState$.pipe(
      map((state) => options.webrtcPreferred && state.phase === "connected"),
      distinctUntilChanged(),
    );
    const media$ = mediaActive$.pipe(
      switchMap((active) =>
        active
          ? webRTCMedia$({
              sessionId: options.sessionId,
              sessionToken: options.sessionToken,
              credentials: options.credentials,
              iceServers: options.iceServers,
              input$: webRTCInput$,
              viewportSize$: webRTCViewport$,
              streamSettings$: webRTCStreamSettings$,
            })
          : of(initialMediaState),
      ),
      startWith(initialMediaState),
      shareReplay({ bufferSize: 1, refCount: true }),
    );
    const state$ = combineLatest([cdpState$, media$]).pipe(
      map(([cdp, media]) => browserState(options.webrtcPreferred, cdp, media)),
      shareReplay({ bufferSize: 1, refCount: true }),
    );
    const webRTCViewportSync$ = combineLatest([viewport$, media$]).pipe(
      filter(([, media]) => options.webrtcPreferred && media.phase !== "failed"),
      map(([viewport]) => ({
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: viewport.deviceScaleFactor,
      })),
      distinctUntilChanged(
        (a, b) =>
          a.width === b.width &&
          a.height === b.height &&
          a.deviceScaleFactor === b.deviceScaleFactor,
      ),
      tap((size) => webRTCViewport$.next(size)),
      ignoreElements(),
    );
    const webRTCSettingsSync$ = options.streamSettings$.pipe(
      tap((settings) => webRTCStreamSettings$.next(settings)),
      ignoreElements(),
    );
    const viewportToCdp$ = combineLatest([viewport$, cdpState$]).pipe(
      map(([viewport, cdp]) => viewportCommand(options.webrtcPreferred, viewport, cdp)),
      distinctUntilChanged(sameViewportCommand),
      filter(isViewportCommand),
      tap((command) => cdpInput$.next(command)),
      ignoreElements(),
    );
    const routedInput$ = options.input$.pipe(
      withLatestFrom(media$),
      tap(([message, media]) => {
        if (isInputMessage(message) && shouldUseWebRTCInput(media)) {
          webRTCInput$.next(scaleWebRTCInput(message));
          return;
        }
        cdpInput$.next(message);
      }),
      ignoreElements(),
    );
    const stopCdpScreencastOnLive$ = media$.pipe(
      map((media) => media.phase === "live" && Boolean(media.stream)),
      distinctUntilChanged(),
      filter(Boolean),
      tap(() => cdpInput$.next({ type: "screencast.stop" })),
      ignoreElements(),
    );
    const manualScreencast$ = options.startScreencast$.pipe(
      withLatestFrom(state$, viewport$),
      tap(([, state, viewport]) => cdpInput$.next(screencastStartCommand(state, viewport))),
      ignoreElements(),
    );
    const fallbackScreencast$ = combineLatest([state$, viewport$]).pipe(
      switchMap(([state, viewport]) => {
        if (!shouldStartFallbackScreencast(options.webrtcPreferred, state)) {
          return EMPTY;
        }
        return timer(state.mediaPhase === "failed" ? 0 : 2500).pipe(
          tap(() => cdpInput$.next(screencastStartCommand(state, viewport))),
        );
      }),
      ignoreElements(),
    );
    const errorOutput$ = cdpOutput$.pipe(
      filter((output) => output.type === "error"),
      map((output): BrowserControlOutput => ({ type: "error", error: output.error })),
    );

    const subscription = merge(
      state$.pipe(map((state): BrowserControlOutput => ({ type: "state", state }))),
      errorOutput$,
      webRTCViewportSync$,
      webRTCSettingsSync$,
      viewportToCdp$,
      routedInput$,
      stopCdpScreencastOnLive$,
      manualScreencast$,
      fallbackScreencast$,
    ).subscribe(subscriber);

    return () => {
      subscription.unsubscribe();
      cdpInput$.complete();
      webRTCInput$.complete();
      webRTCViewport$.complete();
      webRTCStreamSettings$.complete();
    };
  });
}

function browserState(
  webrtcPreferred: boolean,
  cdp: CdpControlState,
  media: WebRTCMediaState,
): BrowserControlState {
  const mediaLive = media.phase === "live" && Boolean(media.stream);
  return {
    phase: cdp.phase,
    targets: cdp.targets,
    activeTargetId: cdp.activeTargetId,
    frame: mediaLive ? null : cdp.frame,
    mediaPhase: media.phase,
    mediaStream: media.stream,
    mediaSize: media.size,
    mediaStreamSettings: media.streamSettings,
    mediaMetrics: media.metrics,
    mediaError: media.error ? webRTCMediaErrorMessage(media.error) : null,
    mediaPath: resolveMediaPath(webrtcPreferred, media.phase, media.stream),
    lastError: cdp.lastError,
  };
}

function viewportCommand(
  webrtcPreferred: boolean,
  viewport: ViewportPreset,
  cdp: CdpControlState,
): ViewportCommand | null {
  if (cdp.phase !== "connected" || !cdp.activeTargetId) {
    return null;
  }
  if (webrtcPreferred) {
    return null;
  }
  return {
    type: "viewport.set",
    targetId: cdp.activeTargetId,
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor,
  };
}

function sameViewportCommand(a: ViewportCommand | null, b: ViewportCommand | null): boolean {
  return (
    a?.targetId === b?.targetId &&
    a?.width === b?.width &&
    a?.height === b?.height &&
    a?.deviceScaleFactor === b?.deviceScaleFactor
  );
}

function isViewportCommand(command: ViewportCommand | null): command is ViewportCommand {
  return command !== null;
}

function shouldUseWebRTCInput(media: WebRTCMediaState): boolean {
  return media.phase === "live" && Boolean(media.stream) && media.inputReady;
}

function scaleWebRTCInput(message: WebRTCInputMessage): WebRTCInputMessage {
  return message.type === "input.wheel"
    ? {
        ...message,
        deltaX: message.deltaX * WEBRTC_WHEEL_DELTA_SCALE,
        deltaY: message.deltaY * WEBRTC_WHEEL_DELTA_SCALE,
      }
    : message;
}

function screencastStartCommand(
  state: BrowserControlState,
  viewport: ViewportPreset,
): Extract<ClientMessage, { type: "screencast.start" }> {
  return {
    type: "screencast.start",
    targetId: state.activeTargetId ?? undefined,
    format: "jpeg",
    quality: 80,
    maxWidth: viewport.width,
    maxHeight: viewport.height,
  };
}

function shouldStartFallbackScreencast(
  webrtcPreferred: boolean,
  state: BrowserControlState,
): boolean {
  if (state.phase !== "connected" || state.frame || !state.activeTargetId) {
    return false;
  }
  if (!webrtcPreferred || state.mediaPhase === "failed") {
    return true;
  }
  return state.mediaPhase === "live" && !state.mediaStream;
}

function isInputMessage(message: ClientMessage): message is WebRTCInputMessage {
  return (
    message.type === "input.mouse" || message.type === "input.wheel" || message.type === "input.key"
  );
}

function resolveMediaPath(
  webrtcPreferred: boolean,
  mediaPhase: WebRTCMediaPhase,
  mediaStream: MediaStream | null,
): BrowserMediaPath {
  if (mediaPhase === "live" && mediaStream) {
    return "webrtc-live";
  }
  if (webrtcPreferred && mediaPhase === "failed") {
    return "fallback-cdp";
  }
  return "cdp";
}
