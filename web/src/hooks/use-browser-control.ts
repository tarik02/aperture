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
  WebRTCMediaSize,
  WebRTCStreamSettings,
  WebRTCVideoProfile,
} from "#/lib/control/webrtc-media-transport.ts";
import { apiClient, resolveTenantHeader, type ApiCredentials } from "#/lib/api/client.ts";
import type { Recording } from "#/lib/api/schemas.ts";

type UseBrowserControlOptions = {
  sessionId: string | null;
  credentials?: ApiCredentials;
  sessionToken?: string;
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
  mediaSize: WebRTCMediaSize | null;
  mediaStreamSettings: WebRTCStreamSettings | null;
  mediaVideoProfiles: WebRTCVideoProfile[];
  mediaMetrics: WebRTCMediaMetrics | null;
  mediaError: string | null;
  mediaPath: BrowserMediaPath;
  mediaTargetId: string | null;
  mediaSwitching: boolean;
  lastError: ControlError | null;
  viewport: ViewportPreset;
  browserViewportSize: BrowserViewportSize | null;
  viewportAutoSync: boolean;
  captured: boolean;
  recordings: Recording[];
  recordingBusy: boolean;
  recordingClientConnected: boolean;
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
  startRecording: (mode: "tab" | "viewer") => void;
  stopRecording: (recordingId: string) => void;
  cancelRecording: (recordingId: string) => void;
  reconnect: () => void;
};

const emptyIceServers: RTCIceServer[] = [];

export function useBrowserControl({
  sessionId,
  credentials: credentialsOverride,
  sessionToken,
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
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [recordingBusy, setRecordingBusy] = useState(false);
  const [recordingClientConnected, setRecordingClientConnected] = useState(false);

  const activeTargetIdRef = useRef<string | null>(null);
  const viewportRef = useRef(viewport);
  const browserViewportSizeRef = useRef<BrowserViewportSize | null>(null);
  const viewportAutoSyncRef = useRef(false);
  const controlEnabledRef = useRef(false);
  const recordingClientSocketRef = useRef<WebSocket | null>(null);
  const recordingClientIdRef = useRef<string | null>(null);
  const recordingTargetIdRef = useRef<string | null>(null);
  const webrtcPreferred = Boolean(
    enabled && sessionId && credentials && webrtcProducerSupported && !forceCDPMedia,
  );
  const recordingTenantId = credentials
    ? resolveTenantHeader(credentials, "tenant-scoped")
    : undefined;
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
            nextSessionToken,
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
              sessionToken: nextSessionToken,
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
    [enabled, sessionId, credentials, sessionToken, webrtcPreferred, webrtcIceServers],
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
  if (controlState.mediaTargetId) {
    recordingTargetIdRef.current = controlState.mediaTargetId;
  } else if (!controlState.mediaSwitching) {
    recordingTargetIdRef.current = activeTargetId;
  }

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

  const startRecording = useCallback(
    (mode: "tab" | "viewer") => {
      const targetId = mode === "viewer" ? recordingTargetIdRef.current : activeTargetIdRef.current;
      const clientId = recordingClientIdRef.current;
      if (
        !sessionId ||
        !credentials ||
        !targetId ||
        !recordingClientConnected ||
        !clientId ||
        recordingBusy
      ) {
        return;
      }
      setRecordingBusy(true);
      apiClient
        .startSessionRecording(credentials, sessionId, { mode, targetId, clientId })
        .then((recording) => {
          setRecordings((current) => [
            ...current.filter((candidate) => candidate.recordingId !== recording.recordingId),
            recording,
          ]);
        })
        .catch((cause: unknown) => {
          toast.error(errorMessage(cause, "Recording failed to start"));
        })
        .finally(() => setRecordingBusy(false));
    },
    [sessionId, credentials, recordingBusy, recordingClientConnected],
  );

  const stopRecording = useCallback(
    (recordingId: string) => {
      if (!sessionId || !credentials || recordingBusy) {
        return;
      }
      setRecordingBusy(true);
      apiClient
        .stopSessionRecording(credentials, sessionId, recordingId)
        .then(({ blob, filename }) => {
          const recording = recordings.find((candidate) => candidate.recordingId === recordingId);
          downloadBlob(
            blob,
            filename ?? `${sessionId}-${recording?.targetId ?? "target"}-${recordingId}.webm`,
          );
          void apiClient
            .getSessionRecording(credentials, sessionId, recordingId)
            .then((status) => {
              setRecordings((current) =>
                current.map((candidate) =>
                  candidate.recordingId === status.recordingId ? status : candidate,
                ),
              );
            })
            .catch(() => {
              setRecordings((current) =>
                current.map((candidate) =>
                  candidate.recordingId === recordingId
                    ? { ...candidate, status: "stopped", stopReason: "requested" }
                    : candidate,
                ),
              );
            });
          toast.success("Recording saved");
        })
        .catch((cause: unknown) => {
          toast.error(errorMessage(cause, "Recording failed to stop"));
        })
        .finally(() => setRecordingBusy(false));
    },
    [sessionId, credentials, recordingBusy, recordings],
  );

  const cancelRecording = useCallback(
    (recordingId: string) => {
      if (!sessionId || !credentials || recordingBusy) {
        return;
      }
      setRecordingBusy(true);
      apiClient
        .cancelSessionRecording(credentials, sessionId, recordingId)
        .then(() => apiClient.getSessionRecording(credentials, sessionId, recordingId))
        .then((status) => {
          setRecordings((current) =>
            current.map((candidate) =>
              candidate.recordingId === status.recordingId ? status : candidate,
            ),
          );
          toast.success("Recording stopped");
        })
        .catch((cause: unknown) => {
          toast.error(errorMessage(cause, "Recording failed to stop"));
        })
        .finally(() => setRecordingBusy(false));
    },
    [sessionId, credentials, recordingBusy],
  );

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
    setRecordings([]);
    setRecordingBusy(false);
  }, [enabled, sessionId, credentials]);

  useEffect(() => {
    const token = credentials?.token;
    if (!enabled || !sessionId || !token) {
      setRecordingClientConnected(false);
      recordingClientIdRef.current = null;
      return;
    }

    let active = true;
    let retryTimer: number | null = null;
    let heartbeatTimer: number | null = null;

    const connect = () => {
      const clientId = crypto.randomUUID();
      const protocols = ["aperture-recording.v1", `authorization.bearer.${token}`];
      if (recordingTenantId) {
        protocols.push(`x-aperture-tenant-id.${recordingTenantId}`);
      }
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(
        `${protocol}//${window.location.host}/sessions/${encodeURIComponent(sessionId)}/recordings/client?clientId=${encodeURIComponent(clientId)}`,
        protocols,
      );
      recordingClientSocketRef.current = socket;
      recordingClientIdRef.current = clientId;

      socket.addEventListener("open", () => {
        if (!active || recordingClientSocketRef.current !== socket) {
          socket.close();
          return;
        }
        setRecordingClientConnected(true);
        const targetId = recordingTargetIdRef.current;
        if (targetId) {
          socket.send(JSON.stringify({ version: 1, type: "target.select", targetId }));
        }
        heartbeatTimer = window.setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ version: 1, type: "heartbeat" }));
          }
        }, 30_000);
      });
      socket.addEventListener("error", () => socket.close());
      socket.addEventListener("close", () => {
        if (recordingClientSocketRef.current !== socket) {
          return;
        }
        recordingClientSocketRef.current = null;
        recordingClientIdRef.current = null;
        setRecordingClientConnected(false);
        if (heartbeatTimer !== null) {
          window.clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        if (active) {
          retryTimer = window.setTimeout(connect, 1000);
        }
      });
    };

    connect();
    return () => {
      active = false;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
      if (heartbeatTimer !== null) {
        window.clearInterval(heartbeatTimer);
      }
      const socket = recordingClientSocketRef.current;
      recordingClientSocketRef.current = null;
      recordingClientIdRef.current = null;
      setRecordingClientConnected(false);
      socket?.close();
    };
  }, [enabled, sessionId, credentials?.token, recordingTenantId]);

  useEffect(() => {
    const socket = recordingClientSocketRef.current;
    const targetId = recordingTargetIdRef.current;
    if (socket?.readyState === WebSocket.OPEN && targetId) {
      socket.send(JSON.stringify({ version: 1, type: "target.select", targetId }));
    }
  }, [activeTargetId, controlState.mediaTargetId]);

  useEffect(() => {
    if (!enabled || !sessionId || !credentials) {
      return;
    }
    let active = true;
    const refresh = () => {
      void apiClient
        .listSessionRecordings(credentials, sessionId)
        .then((nextRecordings) => {
          if (active) {
            setRecordings(nextRecordings);
          }
        })
        .catch(() => undefined);
    };
    refresh();
    return () => {
      active = false;
    };
  }, [enabled, sessionId, credentials]);

  const recordingPollingActive = recordings.some(
    (recording) => recording.status === "starting" || recording.status === "running",
  );

  useEffect(() => {
    if (!enabled || !sessionId || !credentials || !recordingPollingActive) {
      return;
    }
    let active = true;
    const timer = window.setInterval(() => {
      void apiClient
        .listSessionRecordings(credentials, sessionId)
        .then((nextRecordings) => {
          if (active) {
            setRecordings(nextRecordings);
          }
        })
        .catch(() => undefined);
    }, 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [enabled, sessionId, credentials, recordingPollingActive]);

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
    mediaVideoProfiles: controlState.mediaVideoProfiles,
    mediaMetrics: controlState.mediaMetrics,
    mediaError: controlState.mediaError,
    mediaPath: controlState.mediaPath,
    mediaTargetId: controlState.mediaTargetId,
    mediaSwitching: controlState.mediaSwitching,
    lastError: controlState.lastError,
    viewport,
    browserViewportSize,
    viewportAutoSync,
    captured,
    recordings,
    recordingBusy,
    recordingClientConnected,
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
    cancelRecording,
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
