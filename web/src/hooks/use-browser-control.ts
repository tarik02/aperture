import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useObservable,
  useObservableCallback,
  useObservableState,
  useSubscription,
} from "observable-hooks";
import { filter, map, of, share, switchMap } from "rxjs";
import { toast } from "sonner";
import {
  browserControl$,
  initialBrowserControlState,
  type BrowserControlOutput,
  type BrowserMediaPath,
} from "#/lib/control/browser-control-transport.ts";
import type {
  ClientMessage,
  ControlConnectionPhase,
  ControlError,
  ControlTarget,
  ScreencastFrame,
} from "#/lib/control/messages.ts";
import {
  createViewportPreset,
  DEFAULT_VIEWPORT,
  type ViewportPreset,
} from "#/lib/control/viewport.ts";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import type {
  WebRTCMediaMetrics,
  WebRTCMediaPhase,
  WebRTCStreamSettings,
} from "#/lib/control/webrtc-media-transport.ts";
import { apiClient, type ApiCredentials } from "#/lib/api/client.ts";

type UseBrowserControlOptions = {
  sessionId: string | null;
  credentials?: ApiCredentials;
  cdpToken?: string;
  enabled?: boolean;
  webrtcProducerSupported?: boolean;
  webrtcIceServers?: RTCIceServer[];
  forceCDPMedia?: boolean;
};

type BrowserViewportSize = {
  width: number;
  height: number;
};

export type UseBrowserControlResult = {
  phase: ControlConnectionPhase;
  targets: ControlTarget[];
  activeTargetId: string | null;
  activeTarget: ControlTarget | null;
  frame: ScreencastFrame | null;
  frameStale: boolean;
  mediaPhase: WebRTCMediaPhase;
  mediaStream: MediaStream | null;
  mediaSize: BrowserViewportSize | null;
  mediaStreamSettings: WebRTCStreamSettings | null;
  mediaMetrics: WebRTCMediaMetrics | null;
  mediaError: string | null;
  mediaPath: BrowserMediaPath;
  lastError: ControlError | null;
  viewport: ViewportPreset;
  browserViewportSize: BrowserViewportSize | null;
  viewportAutoSync: boolean;
  captured: boolean;
  recordingActive: boolean;
  recordingBusy: boolean;
  setCaptured: (captured: boolean) => void;
  setViewport: (viewport: ViewportPreset) => void;
  setBrowserViewportSize: (size: BrowserViewportSize) => void;
  setViewportAutoSync: (enabled: boolean) => void;
  setViewportToBrowserSize: () => void;
  setWebRTCStreamSettings: (settings: WebRTCStreamSettings) => boolean;
  send: (message: ClientMessage) => boolean;
  activateTarget: (targetId: string) => void;
  reorderTargets: (
    sourceTargetId: string,
    destinationTargetId: string,
    placement: "before" | "after",
  ) => void;
  createTarget: (url?: string) => void;
  closeTarget: (targetId: string) => void;
  navigate: (url: string) => void;
  reload: () => void;
  stopLoading: () => void;
  historyBack: () => void;
  historyForward: () => void;
  startScreencast: () => void;
  startRecording: () => void;
  stopRecording: () => void;
  reconnect: () => void;
};

const emptyIceServers: RTCIceServer[] = [];

export function useBrowserControl({
  sessionId,
  credentials: credentialsOverride,
  cdpToken,
  enabled = true,
  webrtcProducerSupported = false,
  webrtcIceServers = emptyIceServers,
  forceCDPMedia = false,
}: UseBrowserControlOptions): UseBrowserControlResult {
  const profileCredentials = useApiCredentials();
  const credentials = credentialsOverride ?? profileCredentials;
  const [targets, setTargets] = useState<ControlTarget[]>([]);
  const [frameStale, setFrameStale] = useState(false);
  const [viewport, setViewport] = useState<ViewportPreset>(DEFAULT_VIEWPORT);
  const [browserViewportSize, setBrowserViewportSizeState] = useState<BrowserViewportSize | null>(
    null,
  );
  const [viewportAutoSync, setViewportAutoSyncState] = useState(false);
  const [captured, setCaptured] = useState(false);
  const [recordingActive, setRecordingActive] = useState(false);
  const [recordingBusy, setRecordingBusy] = useState(false);

  const activeTargetIdRef = useRef<string | null>(null);
  const viewportRef = useRef(viewport);
  const browserViewportSizeRef = useRef<BrowserViewportSize | null>(null);
  const viewportAutoSyncRef = useRef(false);
  const controlEnabledRef = useRef(false);
  const webrtcPreferred = Boolean(
    enabled && sessionId && credentials && webrtcProducerSupported && !forceCDPMedia,
  );
  const [pushMessage, message$] = useObservableCallback<ClientMessage>();
  const [pushViewport, viewport$] = useObservableCallback<ViewportPreset>();
  const [pushStreamSettings, streamSettings$] = useObservableCallback<WebRTCStreamSettings>();
  const [pushReconnect, reconnect$] = useObservableCallback<void>();
  const [pushScreencast, screencast$] = useObservableCallback<void>();
  const controlOutput$ = useObservable(
    (input$) =>
      input$.pipe(
        switchMap(
          ([
            nextEnabled,
            nextSessionId,
            nextCredentials,
            nextCdpToken,
            nextWebrtcPreferred,
            nextIceServers,
          ]) => {
            if (!nextEnabled || !nextSessionId || !nextCredentials) {
              return of<BrowserControlOutput>({
                type: "state",
                state: initialBrowserControlState,
              });
            }
            return browserControl$({
              sessionId: nextSessionId,
              credentials: nextCredentials,
              cdpToken: nextCdpToken,
              webrtcPreferred: nextWebrtcPreferred,
              iceServers: nextIceServers,
              viewport: viewportRef.current,
              input$: message$,
              viewport$,
              streamSettings$,
              reconnect$,
              startScreencast$: screencast$,
            });
          },
        ),
        share(),
      ),
    [enabled, sessionId, credentials, cdpToken, webrtcPreferred, webrtcIceServers],
  );
  const controlState$ = useMemo(
    () =>
      controlOutput$.pipe(
        filter(isBrowserControlStateOutput),
        map((output) => output.state),
      ),
    [controlOutput$],
  );
  const controlState = useObservableState(controlState$, initialBrowserControlState);
  const activeTargetId = controlState.activeTargetId;
  const frame = controlState.frame;

  activeTargetIdRef.current = activeTargetId;
  viewportRef.current = viewport;
  browserViewportSizeRef.current = browserViewportSize;
  viewportAutoSyncRef.current = viewportAutoSync;
  controlEnabledRef.current = Boolean(enabled && sessionId && credentials);

  const activeTarget = useMemo(
    () => targets.find((target) => target.id === activeTargetId) ?? null,
    [targets, activeTargetId],
  );

  const send = useCallback(
    (message: ClientMessage) => {
      if (!controlEnabledRef.current) {
        return false;
      }
      pushMessage(message);
      return true;
    },
    [pushMessage],
  );

  const sendForActive = useCallback(
    (build: (targetId: string) => ClientMessage) => {
      const targetId = activeTargetIdRef.current;
      if (!targetId) {
        return false;
      }
      return send(build(targetId));
    },
    [send],
  );

  const activateTarget = useCallback(
    (targetId: string) => {
      send({ type: "targets.activate", targetId });
    },
    [send],
  );

  const reorderTargets = useCallback(
    (sourceTargetId: string, destinationTargetId: string, placement: "before" | "after") => {
      if (sourceTargetId === destinationTargetId) {
        return;
      }

      setTargets((current) => {
        const startIndex = current.findIndex((target) => target.id === sourceTargetId);
        const destinationIndex = current.findIndex((target) => target.id === destinationTargetId);

        if (startIndex === -1 || destinationIndex === -1) {
          return current;
        }

        const source = current[startIndex];
        if (!source) {
          return current;
        }

        const next = [...current];
        next.splice(startIndex, 1);

        const requestedFinishIndex =
          placement === "after" ? destinationIndex + 1 : destinationIndex;
        const finishIndex =
          startIndex < requestedFinishIndex ? requestedFinishIndex - 1 : requestedFinishIndex;

        if (finishIndex === startIndex) {
          return current;
        }

        next.splice(finishIndex, 0, source);
        return next;
      });
    },
    [],
  );

  const createTarget = useCallback(
    (url?: string) => {
      send({ type: "targets.create", url });
    },
    [send],
  );

  const closeTarget = useCallback(
    (targetId: string) => {
      send({ type: "targets.close", targetId });
    },
    [send],
  );

  const navigate = useCallback(
    (url: string) => {
      sendForActive((targetId) => ({ type: "page.navigate", targetId, url }));
    },
    [sendForActive],
  );

  const reload = useCallback(() => {
    sendForActive((targetId) => ({ type: "page.reload", targetId }));
  }, [sendForActive]);

  const stopLoading = useCallback(() => {
    sendForActive((targetId) => ({ type: "page.stopLoading", targetId }));
  }, [sendForActive]);

  const historyBack = useCallback(() => {
    sendForActive((targetId) => ({ type: "page.historyBack", targetId }));
  }, [sendForActive]);

  const historyForward = useCallback(() => {
    sendForActive((targetId) => ({ type: "page.historyForward", targetId }));
  }, [sendForActive]);

  const startScreencast = useCallback(() => {
    pushScreencast();
  }, [pushScreencast]);

  const startRecording = useCallback(() => {
    if (!sessionId || !credentials || recordingBusy) {
      return;
    }
    setRecordingBusy(true);
    apiClient
      .startSessionScreencast(credentials, sessionId)
      .then((status) => {
        setRecordingActive(status.active);
        toast.success("Recording started");
      })
      .catch((cause: unknown) => {
        toast.error(errorMessage(cause, "Recording failed to start"));
      })
      .finally(() => setRecordingBusy(false));
  }, [sessionId, credentials, recordingBusy]);

  const stopRecording = useCallback(() => {
    if (!sessionId || !credentials || recordingBusy) {
      return;
    }
    setRecordingBusy(true);
    apiClient
      .stopSessionScreencast(credentials, sessionId)
      .then(({ blob, filename }) => {
        setRecordingActive(false);
        downloadBlob(blob, filename ?? `${sessionId}-screencast.webm`);
        toast.success("Recording saved");
      })
      .catch((cause: unknown) => {
        toast.error(errorMessage(cause, "Recording failed to stop"));
      })
      .finally(() => setRecordingBusy(false));
  }, [sessionId, credentials, recordingBusy]);

  const commitViewport = useCallback(
    (preset: ViewportPreset) => {
      setViewport(preset);
      pushViewport(preset);
    },
    [pushViewport],
  );

  const applyViewport = useCallback(
    (preset: ViewportPreset) => {
      viewportAutoSyncRef.current = false;
      setViewportAutoSyncState(false);
      commitViewport(preset);
    },
    [commitViewport],
  );

  const syncViewportToBrowserSize = useCallback(() => {
    const size = browserViewportSizeRef.current;
    if (!size) {
      return;
    }
    commitViewport(createBrowserViewport(size, viewportRef.current.deviceScaleFactor));
  }, [commitViewport]);

  const setViewportToBrowserSize = useCallback(() => {
    const size = browserViewportSizeRef.current;
    if (!size) {
      return;
    }
    viewportAutoSyncRef.current = false;
    setViewportAutoSyncState(false);
    commitViewport(createBrowserViewport(size, viewportRef.current.deviceScaleFactor));
  }, [commitViewport]);

  const setWebRTCStreamSettings = useCallback(
    (settings: WebRTCStreamSettings) => {
      if (!controlEnabledRef.current) {
        return false;
      }
      pushStreamSettings(settings);
      return true;
    },
    [pushStreamSettings],
  );

  const setBrowserViewportSize = useCallback(
    (size: BrowserViewportSize) => {
      const next = {
        width: Math.round(size.width),
        height: Math.round(size.height),
      };
      if (next.width < 1 || next.height < 1) {
        return;
      }
      const current = browserViewportSizeRef.current;
      if (current?.width === next.width && current.height === next.height) {
        return;
      }

      browserViewportSizeRef.current = next;
      setBrowserViewportSizeState(next);
      if (viewportAutoSyncRef.current) {
        commitViewport(createBrowserViewport(next, viewportRef.current.deviceScaleFactor));
      }
    },
    [commitViewport],
  );

  const setViewportAutoSync = useCallback(
    (enabled: boolean) => {
      viewportAutoSyncRef.current = enabled;
      setViewportAutoSyncState(enabled);
      if (enabled) {
        syncViewportToBrowserSize();
      }
    },
    [syncViewportToBrowserSize],
  );

  const reconnect = useCallback(() => {
    pushReconnect();
  }, [pushReconnect]);

  const controlError$ = useMemo(
    () =>
      controlOutput$.pipe(
        filter(isBrowserControlErrorOutput),
        map((output) => output.error),
      ),
    [controlOutput$],
  );

  useSubscription(controlError$, (error) => {
    if (error.code !== "not_implemented" && !isDisconnectedSocketError(error.message)) {
      toast.error(error.message);
    }
  });

  useEffect(() => {
    setTargets((current) => mergeTargetsInCurrentOrder(current, controlState.targets));
    if (controlState.frame) {
      setFrameStale(false);
    }
    if (controlState.phase !== "connected") {
      setCaptured(false);
    }
  }, [controlState]);

  useEffect(() => {
    if (enabled && sessionId && credentials) {
      return;
    }
    setRecordingActive(false);
    setRecordingBusy(false);
  }, [enabled, sessionId, credentials]);

  useEffect(() => {
    if (!enabled || !sessionId || !credentials) {
      return;
    }
    apiClient
      .getSessionScreencastStatus(credentials, sessionId)
      .then((status) => {
        setRecordingActive(status.active);
      })
      .catch(() => undefined);
  }, [enabled, sessionId, credentials]);

  useEffect(() => {
    if (
      controlState.phase !== "connected" ||
      controlState.mediaPhase !== "live" ||
      !controlState.mediaStream ||
      !controlState.mediaSize
    ) {
      return;
    }

    const current = viewportRef.current;
    if (
      current.width === controlState.mediaSize.width &&
      current.height === controlState.mediaSize.height &&
      current.deviceScaleFactor === controlState.mediaSize.deviceScaleFactor
    ) {
      return;
    }

    setViewport(
      createBrowserViewport(controlState.mediaSize, controlState.mediaSize.deviceScaleFactor),
    );
  }, [
    controlState.phase,
    controlState.mediaPhase,
    controlState.mediaStream,
    controlState.mediaSize,
  ]);

  useEffect(() => {
    if (!frame) {
      setFrameStale(false);
      return;
    }

    const timer = window.setInterval(() => {
      setFrameStale(Date.now() - frame.receivedAt > 3000);
    }, 500);

    return () => window.clearInterval(timer);
  }, [frame]);

  return {
    phase: controlState.phase,
    targets,
    activeTargetId,
    activeTarget,
    frame,
    frameStale,
    mediaPhase: controlState.mediaPhase,
    mediaStream: controlState.mediaStream,
    mediaSize: controlState.mediaSize,
    mediaStreamSettings: controlState.mediaStreamSettings,
    mediaMetrics: controlState.mediaMetrics,
    mediaError: controlState.mediaError,
    mediaPath: controlState.mediaPath,
    lastError: controlState.lastError,
    viewport,
    browserViewportSize,
    viewportAutoSync,
    captured,
    recordingActive,
    recordingBusy,
    setCaptured,
    setViewport: applyViewport,
    setBrowserViewportSize,
    setViewportAutoSync,
    setViewportToBrowserSize,
    setWebRTCStreamSettings,
    send,
    activateTarget,
    reorderTargets,
    createTarget,
    closeTarget,
    navigate,
    reload,
    stopLoading,
    historyBack,
    historyForward,
    startScreencast,
    startRecording,
    stopRecording,
    reconnect,
  };
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

function isDisconnectedSocketError(message: string): boolean {
  return /^CDP (browser )?socket (is not open|closed|failed)$/.test(message);
}

function isBrowserControlStateOutput(
  output: BrowserControlOutput,
): output is Extract<BrowserControlOutput, { type: "state" }> {
  return output.type === "state";
}

function isBrowserControlErrorOutput(
  output: BrowserControlOutput,
): output is Extract<BrowserControlOutput, { type: "error" }> {
  return output.type === "error";
}

function mergeTargetsInCurrentOrder(
  currentTargets: ControlTarget[],
  nextTargets: ControlTarget[],
): ControlTarget[] {
  const nextById = new Map(nextTargets.map((target) => [target.id, target]));
  const seen = new Set<string>();
  const ordered: ControlTarget[] = [];

  for (const currentTarget of currentTargets) {
    const nextTarget = nextById.get(currentTarget.id);
    if (nextTarget) {
      ordered.push(nextTarget);
      seen.add(nextTarget.id);
    }
  }

  for (const nextTarget of nextTargets) {
    if (!seen.has(nextTarget.id)) {
      ordered.push(nextTarget);
    }
  }

  return ordered;
}

function createBrowserViewport(
  size: BrowserViewportSize,
  deviceScaleFactor: number,
): ViewportPreset {
  return createViewportPreset(size.width, size.height, deviceScaleFactor);
}
