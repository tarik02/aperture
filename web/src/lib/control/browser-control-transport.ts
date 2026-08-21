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
import { apiClient, type ApiCredentials } from "#/lib/api/client.ts";
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
  type WebRTCVideoProfile,
  type WebRTCViewportRequest,
} from "#/lib/control/webrtc-media-transport.ts";

export type BrowserMediaPath = "cdp" | "webrtc-live" | "fallback-cdp";

export type BrowserMediaSelection =
  | { kind: "fallback-cdp" }
  | { kind: "webrtc"; settings: WebRTCStreamSettings }
  | { kind: "webrtc-retry" };

export type BrowserControlState = {
  phase: ControlConnectionPhase;
  targets: ControlTarget[];
  activeTargetId: string | null;
  mediaPhase: WebRTCMediaPhase;
  mediaStream: MediaStream | null;
  mediaSize: WebRTCMediaSize | null;
  mediaStreamSettings: WebRTCStreamSettings | null;
  mediaVideoProfiles: WebRTCVideoProfile[];
  mediaMetrics: WebRTCMediaMetrics | null;
  mediaError: string | null;
  mediaPath: BrowserMediaPath;
  mediaTargetId: string | null;
  mediaSwitching: boolean;
  lastError: ControlError | null;
};

type ConnectOptions = {
  webrtcPreferred: boolean;
  iceServers: RTCIceServer[];
  viewport: ViewportPreset;
};

type BrowserControlOptions = ConnectOptions & {
  sessionId: string;
  credentials: ApiCredentials;
  sessionToken?: string;
  input$: Observable<ClientMessage>;
  viewport$: Observable<ViewportPreset>;
  streamSettings$: Observable<WebRTCStreamSettings>;
  mediaSelection$: Observable<BrowserMediaSelection>;
  reconnect$: Observable<void>;
  startScreencast$: Observable<void>;
};

export type BrowserControlOutput =
  | { type: "state"; state: BrowserControlState }
  | { type: "frame"; frame: ScreencastFrame | null }
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
  videoProfiles: [],
  metrics: null,
  error: null,
  inputReady: false,
  selectedTarget: null,
  targetSwitching: false,
};
const initialCdpState: CdpControlState = {
  phase: "idle",
  targets: [],
  activeTargetId: null,
  lastError: null,
};
const WEBRTC_WHEEL_DELTA_SCALE = 0.1;

export const initialBrowserControlState: BrowserControlState = browserState(
  false,
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
    const webRTCReconnect$ = new Subject<void>();
    const mediaSelectionError$ = new Subject<BrowserControlOutput>();
    const mediaSelection$ = options.mediaSelection$.pipe(share());
    const fallbackSelected$ = mediaSelection$.pipe(
      map((selection) => selection.kind === "fallback-cdp"),
      startWith(false),
      distinctUntilChanged(),
      shareReplay({ bufferSize: 1, refCount: true }),
    );
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
          sessionToken: options.sessionToken,
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
    const cdpFrame$ = merge(
      options.reconnect$.pipe(map(() => null)),
      cdpOutput$.pipe(
        filter((output) => output.type === "frame"),
        map((output) => output.frame),
      ),
    ).pipe(startWith<ScreencastFrame | null>(null), shareReplay({ bufferSize: 1, refCount: true }));
    const mediaActive$ = cdpState$.pipe(
      map((state) => options.webrtcPreferred && state.phase === "connected"),
      distinctUntilChanged(),
    );
    const media$ = combineLatest([mediaActive$, webRTCReconnect$.pipe(startWith(undefined))]).pipe(
      switchMap(([active]) =>
        active
          ? webRTCMedia$({
              sessionId: options.sessionId,
              credentials: options.credentials,
              sessionToken: options.sessionToken,
              iceServers: options.iceServers,
              input$: webRTCInput$,
              inputEnabled$: fallbackSelected$.pipe(map((selected) => !selected)),
              targetId$: cdpState$.pipe(
                map((state) => state.activeTargetId),
                distinctUntilChanged(),
              ),
              viewportSize$: webRTCViewport$,
              streamSettings$: webRTCStreamSettings$,
              reconnect: () => webRTCReconnect$.next(),
            })
          : of(initialMediaState),
      ),
      startWith(initialMediaState),
      shareReplay({ bufferSize: 1, refCount: true }),
    );
    const state$ = combineLatest([cdpState$, media$, fallbackSelected$]).pipe(
      map(([cdp, media, fallbackSelected]) =>
        browserState(options.webrtcPreferred, fallbackSelected, cdp, media),
      ),
      shareReplay({ bufferSize: 1, refCount: true }),
    );
    const webRTCViewportSync$ = combineLatest([
      viewport$,
      cdpState$,
      media$,
      fallbackSelected$,
    ]).pipe(
      map(([viewport, cdp, media, fallbackSelected]): WebRTCViewportRequest | null =>
        options.webrtcPreferred &&
        !fallbackSelected &&
        media.phase !== "failed" &&
        cdp.activeTargetId
          ? {
              targetId: cdp.activeTargetId,
              width: viewport.width,
              height: viewport.height,
              deviceScaleFactor: viewport.deviceScaleFactor,
            }
          : null,
      ),
      filter((request): request is WebRTCViewportRequest => request !== null),
      distinctUntilChanged(
        (a, b) =>
          a.targetId === b.targetId &&
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
    const mediaSelectionSync$ = mediaSelection$.pipe(
      withLatestFrom(media$),
      tap(([selection, media]) => {
        switch (selection.kind) {
          case "fallback-cdp":
            return;
          case "webrtc":
            webRTCStreamSettings$.next(selection.settings);
            if (media.phase === "failed") {
              void apiClient
                .setBrowserMediaProfile(
                  options.credentials,
                  options.sessionId,
                  selection.settings.profile,
                  options.sessionToken,
                )
                .then(() => webRTCReconnect$.next())
                .catch((cause: unknown) => {
                  mediaSelectionError$.next({
                    type: "error",
                    error: {
                      code: "media_profile_update_failed",
                      message:
                        cause instanceof Error ? cause.message : "Media profile update failed",
                    },
                  });
                });
            }
            return;
          case "webrtc-retry":
            webRTCReconnect$.next();
            return;
          default: {
            const exhaustive: never = selection;
            return exhaustive;
          }
        }
      }),
      ignoreElements(),
    );
    const viewportToCdp$ = combineLatest([viewport$, cdpState$, fallbackSelected$]).pipe(
      map(([viewport, cdp, fallbackSelected]) =>
        viewportCommand(options.webrtcPreferred && !fallbackSelected, viewport, cdp),
      ),
      distinctUntilChanged(sameViewportCommand),
      filter(isViewportCommand),
      tap((command) => cdpInput$.next(command)),
      ignoreElements(),
    );
    const routedInput$ = options.input$.pipe(
      withLatestFrom(media$, fallbackSelected$),
      tap(([message, media, fallbackSelected]) => {
        if (isInputMessage(message)) {
          if (!fallbackSelected && shouldUseWebRTCInput(media, message.targetId)) {
            webRTCInput$.next(scaleWebRTCInput(message));
            return;
          }
          if (!fallbackSelected && options.webrtcPreferred && media.phase !== "failed") {
            return;
          }
          cdpInput$.next(message);
          return;
        }
        cdpInput$.next(message);
      }),
      ignoreElements(),
    );
    const stopCdpScreencastOnLive$ = combineLatest([media$, fallbackSelected$]).pipe(
      map(
        ([media, fallbackSelected]) =>
          !fallbackSelected &&
          media.phase === "live" &&
          Boolean(media.stream) &&
          Boolean(media.selectedTarget) &&
          !media.targetSwitching,
      ),
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
    const fallbackScreencast$ = combineLatest([state$, viewport$, cdpFrame$]).pipe(
      switchMap(([state, viewport, frame]) => {
        if (!shouldStartFallbackScreencast(options.webrtcPreferred, state, frame)) {
          return EMPTY;
        }
        return timer(state.mediaPath === "fallback-cdp" ? 0 : 2500).pipe(
          tap(() => cdpInput$.next(screencastStartCommand(state, viewport))),
        );
      }),
      ignoreElements(),
    );
    const errorOutput$ = cdpOutput$.pipe(
      filter((output) => output.type === "error"),
      map((output): BrowserControlOutput => ({ type: "error", error: output.error })),
    );
    const frameOutput$ = cdpFrame$.pipe(
      map((frame): BrowserControlOutput => ({ type: "frame", frame })),
    );

    const subscription = merge(
      state$.pipe(map((state): BrowserControlOutput => ({ type: "state", state }))),
      frameOutput$,
      errorOutput$,
      mediaSelectionError$,
      webRTCViewportSync$,
      webRTCSettingsSync$,
      mediaSelectionSync$,
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
      webRTCReconnect$.complete();
      mediaSelectionError$.complete();
    };
  });
}

function browserState(
  webrtcPreferred: boolean,
  fallbackSelected: boolean,
  cdp: CdpControlState,
  media: WebRTCMediaState,
): BrowserControlState {
  return {
    phase: cdp.phase,
    targets: cdp.targets,
    activeTargetId: cdp.activeTargetId,
    mediaPhase: media.phase,
    mediaStream: media.stream,
    mediaSize: media.size,
    mediaStreamSettings: media.streamSettings,
    mediaVideoProfiles: media.videoProfiles,
    mediaMetrics: media.metrics,
    mediaError: media.error ? webRTCMediaErrorMessage(media.error) : null,
    mediaPath: resolveMediaPath(webrtcPreferred, fallbackSelected, media.phase, media.stream),
    mediaTargetId: media.selectedTarget?.targetId ?? null,
    mediaSwitching: media.targetSwitching,
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

function shouldUseWebRTCInput(media: WebRTCMediaState, targetId: string): boolean {
  return (
    media.phase === "live" &&
    Boolean(media.stream) &&
    media.inputReady &&
    !media.targetSwitching &&
    media.selectedTarget?.targetId === targetId
  );
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
  frame: ScreencastFrame | null,
): boolean {
  if (state.phase !== "connected" || frame || !state.activeTargetId) {
    return false;
  }
  if (!webrtcPreferred || state.mediaPath === "fallback-cdp") {
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
  fallbackSelected: boolean,
  mediaPhase: WebRTCMediaPhase,
  mediaStream: MediaStream | null,
): BrowserMediaPath {
  if (fallbackSelected) {
    return "fallback-cdp";
  }
  if (mediaPhase === "live" && mediaStream) {
    return "webrtc-live";
  }
  if (webrtcPreferred && mediaPhase === "failed") {
    return "fallback-cdp";
  }
  return "cdp";
}
