import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useObservable,
  useObservableCallback,
  useObservableState,
  useSubscription,
} from "observable-hooks";
import {
  filter,
  interval,
  map,
  of,
  share,
  shareReplay,
  switchMap,
  timer,
  type Observable,
  type Subscription,
} from "rxjs";
import { toast } from "sonner";
import {
  browserControl$,
  initialBrowserControlState,
  type BrowserControlOutput,
  type BrowserMediaSelection,
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
import {
  useCollaborationControl,
  type CollaborationControl,
  type CollaborationRole,
} from "#/hooks/use-collaboration-control.ts";

type UseBrowserControlOptions = {
  sessionId: string | null;
  credentials?: ApiCredentials;
  sessionToken?: string;
  collaborationRole?: CollaborationRole;
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
  frame$: Observable<ScreencastFrame | null>;
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
  remoteCursorEnabled: boolean;
  remoteCursorBusy: boolean;
  collaboration: CollaborationControl;
  setCaptured: (captured: boolean) => void;
  setInputDimensions: (size: BrowserViewportSize) => void;
  setViewport: (viewport: ViewportPreset) => void;
  setBrowserViewportSize: (size: BrowserViewportSize) => void;
  setViewportAutoSync: (enabled: boolean) => void;
  setViewportToBrowserSize: () => void;
  setWebRTCStreamSettings: (settings: WebRTCStreamSettings) => boolean;
  selectMediaStream: (selection: BrowserMediaSelection) => boolean;
  send: (message: ClientMessage) => boolean;
  activateTarget: (targetId: string) => void;
  reorderTargets: (
    sourceTargetId: string,
    destinationTargetId: string,
    placement: "before" | "after",
  ) => void;
  createTarget: (url?: string) => void;
  duplicateTarget: (target: ControlTarget) => void;
  closeTarget: (targetId: string) => void;
  navigate: (url: string) => void;
  reload: (targetId: string) => void;
  stopLoading: () => void;
  historyBack: () => void;
  historyForward: () => void;
  startScreencast: () => void;
  startRecording: (mode: "tab" | "viewer") => void;
  stopRecording: (recordingId: string) => void;
  cancelRecording: (recordingId: string) => void;
  setRemoteCursorEnabled: (enabled: boolean) => void;
  reconnect: () => void;
};

const emptyIceServers: RTCIceServer[] = [];

export function useBrowserControl({
  sessionId,
  credentials: credentialsOverride,
  sessionToken,
  collaborationRole = "owner",
  enabled = true,
  webrtcProducerSupported = false,
  webrtcIceServers = emptyIceServers,
  forceCDPMedia = false,
}: UseBrowserControlOptions): UseBrowserControlResult {
  const profileCredentials = useApiCredentials();
  const credentials = credentialsOverride ?? profileCredentials;
  const [targets, setTargets] = useState<ControlTarget[]>([]);
  const [viewport, setViewport] = useState<ViewportPreset>(DEFAULT_VIEWPORT);
  const [browserViewportSize, setBrowserViewportSizeState] = useState<BrowserViewportSize | null>(
    null,
  );
  const [viewportAutoSync, setViewportAutoSyncState] = useState(false);
  const [captured, setCaptured] = useState(false);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [recordingBusy, setRecordingBusy] = useState(false);
  const [recordingClientConnected, setRecordingClientConnected] = useState(false);
  const [remoteCursorEnabled, setRemoteCursorEnabledState] = useState(true);
  const [remoteCursorBusy, setRemoteCursorBusy] = useState(false);

  const activeTargetIdRef = useRef<string | null>(null);
  const targetsRef = useRef<ControlTarget[]>([]);
  const pendingDuplicateRef = useRef<{
    sourceTargetId: string;
    existingTargetIds: ReadonlySet<string>;
  } | null>(null);
  const viewportRef = useRef(viewport);
  const inputDimensionsRef = useRef<BrowserViewportSize>(DEFAULT_VIEWPORT);
  const browserViewportSizeRef = useRef<BrowserViewportSize | null>(null);
  const viewportAutoSyncRef = useRef(false);
  const controlEnabledRef = useRef(false);
  const recordingClientSocketRef = useRef<WebSocket | null>(null);
  const recordingClientIdRef = useRef<string | null>(null);
  const recordingTargetIdRef = useRef<string | null>(null);
  const webrtcPreferred = Boolean(
    enabled && sessionId && credentials && webrtcProducerSupported && !forceCDPMedia,
  );
  const collaboration = useCollaborationControl({
    sessionId,
    credentials,
    sessionToken,
    role: collaborationRole,
    enabled: Boolean(enabled && sessionId && credentials),
  });
  const recordingTenantId = credentials
    ? resolveTenantHeader(credentials, "tenant-scoped")
    : undefined;
  const [pushMessage, message$] = useObservableCallback<ClientMessage>();
  const [pushViewport, viewport$] = useObservableCallback<ViewportPreset>();
  const [pushStreamSettings, streamSettings$] = useObservableCallback<WebRTCStreamSettings>();
  const [pushMediaSelection, mediaSelection$] = useObservableCallback<BrowserMediaSelection>();
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
              return of(
                { type: "state", state: initialBrowserControlState } satisfies BrowserControlOutput,
                { type: "frame", frame: null } satisfies BrowserControlOutput,
              );
            }
            return browserControl$({
              sessionId: nextSessionId,
              credentials: nextCredentials,
              sessionToken: nextSessionToken,
              webrtcPreferred: nextWebrtcPreferred,
              iceServers: nextIceServers,
              viewport: viewportRef.current,
              viewportUpdatesEnabled: collaborationRole !== "viewer",
              input$: message$,
              viewport$,
              streamSettings$,
              mediaSelection$,
              reconnect$,
              startScreencast$: screencast$,
            });
          },
        ),
        share(),
      ),
    [
      enabled,
      sessionId,
      credentials,
      sessionToken,
      webrtcPreferred,
      webrtcIceServers,
      collaborationRole,
    ],
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
  const frame$ = useMemo(
    () =>
      controlOutput$.pipe(
        filter(isBrowserControlFrameOutput),
        map((output) => output.frame),
        shareReplay({ bufferSize: 1, refCount: true }),
      ),
    [controlOutput$],
  );
  useSubscription(frame$);
  const activeTargetId = controlState.activeTargetId;

  useEffect(() => {
    if (collaboration.phase === "connected") {
      collaboration.setActiveTarget(activeTargetId);
    }
  }, [activeTargetId, collaboration.phase, collaboration.setActiveTarget]);

  useEffect(() => {
    if (!collaboration.followingClientId) {
      return;
    }
    const followed = collaboration.participants.find(
      (participant) => participant.clientId === collaboration.followingClientId,
    );
    if (followed?.activeTargetId && followed.activeTargetId !== activeTargetId) {
      pushMessage({ type: "targets.activate", targetId: followed.activeTargetId });
    }
  }, [activeTargetId, collaboration.followingClientId, collaboration.participants, pushMessage]);

  activeTargetIdRef.current = activeTargetId;
  targetsRef.current = targets;
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
      if (isBrowserInputMessage(message)) {
        return collaboration.sendInput(message, inputDimensionsRef.current);
      }
      if (!browserMessageAllowed(message, collaborationRole)) {
        return false;
      }
      pushMessage(message);
      return true;
    },
    [collaboration, collaborationRole, pushMessage],
  );

  const setInputDimensions = useCallback((size: BrowserViewportSize) => {
    inputDimensionsRef.current = size;
  }, []);

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

  const duplicateTarget = useCallback(
    (target: ControlTarget) => {
      pendingDuplicateRef.current = {
        sourceTargetId: target.id,
        existingTargetIds: new Set(targetsRef.current.map((current) => current.id)),
      };
      if (!send({ type: "targets.create", url: target.url || "about:blank" })) {
        pendingDuplicateRef.current = null;
      }
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

  const reload = useCallback(
    (targetId: string) => {
      send({ type: "page.reload", targetId });
    },
    [send],
  );

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
        .startSessionRecording(credentials, sessionId, { mode, targetId, clientId }, sessionToken)
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
    [sessionId, credentials, sessionToken, recordingBusy, recordingClientConnected],
  );

  const stopRecording = useCallback(
    (recordingId: string) => {
      if (!sessionId || !credentials || recordingBusy) {
        return;
      }
      setRecordingBusy(true);
      apiClient
        .stopSessionRecording(credentials, sessionId, recordingId, sessionToken)
        .then(({ blob, filename }) => {
          const recording = recordings.find((candidate) => candidate.recordingId === recordingId);
          downloadBlob(
            blob,
            filename ?? `${sessionId}-${recording?.targetId ?? "target"}-${recordingId}.webm`,
          );
          void apiClient
            .getSessionRecording(credentials, sessionId, recordingId, sessionToken)
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
    [sessionId, credentials, sessionToken, recordingBusy, recordings],
  );

  const cancelRecording = useCallback(
    (recordingId: string) => {
      if (!sessionId || !credentials || recordingBusy) {
        return;
      }
      setRecordingBusy(true);
      apiClient
        .cancelSessionRecording(credentials, sessionId, recordingId, sessionToken)
        .then(() =>
          apiClient.getSessionRecording(credentials, sessionId, recordingId, sessionToken),
        )
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
    [sessionId, credentials, sessionToken, recordingBusy],
  );

  const setRemoteCursorEnabled = useCallback(
    (visible: boolean) => {
      if (!sessionId || !credentials || remoteCursorBusy) {
        return;
      }
      setRemoteCursorBusy(true);
      void apiClient
        .setBrowserCursor(credentials, sessionId, visible, sessionToken)
        .then((cursor) => setRemoteCursorEnabledState(cursor.visible))
        .catch((cause: unknown) => {
          toast.error(errorMessage(cause, "Remote cursor could not be updated"));
        })
        .finally(() => setRemoteCursorBusy(false));
    },
    [sessionId, credentials, sessionToken, remoteCursorBusy],
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

  const selectMediaStream = useCallback(
    (selection: BrowserMediaSelection) => {
      if (!controlEnabledRef.current) {
        return false;
      }
      pushMediaSelection(selection);
      return true;
    },
    [pushMediaSelection],
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
    const pendingDuplicate = pendingDuplicateRef.current;
    const duplicateTargetId = controlState.activeTargetId;
    if (
      pendingDuplicate &&
      duplicateTargetId &&
      !pendingDuplicate.existingTargetIds.has(duplicateTargetId)
    ) {
      pendingDuplicateRef.current = null;
      reorderTargets(duplicateTargetId, pendingDuplicate.sourceTargetId, "after");
    }
    if (controlState.phase !== "connected") {
      pendingDuplicateRef.current = null;
      setCaptured(false);
    }
  }, [controlState, reorderTargets]);

  useEffect(() => {
    if (enabled && sessionId && credentials && collaborationRole === "owner") {
      return;
    }
    setRecordings([]);
    setRecordingBusy(false);
  }, [enabled, sessionId, credentials, collaborationRole]);

  useEffect(() => {
    setRemoteCursorEnabledState(true);
    if (!enabled || !sessionId || !credentials) {
      setRemoteCursorBusy(false);
      return;
    }

    let active = true;
    setRemoteCursorBusy(true);
    void apiClient
      .getBrowserCursor(credentials, sessionId, sessionToken)
      .then((cursor) => {
        if (active) {
          setRemoteCursorEnabledState(cursor.visible);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) {
          setRemoteCursorBusy(false);
        }
      });
    return () => {
      active = false;
    };
  }, [enabled, sessionId, credentials, sessionToken]);

  useEffect(() => {
    if (!enabled || !sessionId || !credentials || collaborationRole !== "owner") {
      setRecordingClientConnected(false);
      recordingClientIdRef.current = null;
      return;
    }

    let active = true;
    let retrySubscription: Subscription | null = null;
    let heartbeatSubscription: Subscription | null = null;

    const connect = () => {
      const clientId = crypto.randomUUID();
      const protocols = ["aperture-recording.v1"];
      if (sessionToken) {
        protocols.push(`authorization.bearer.${sessionToken}`);
      } else if (credentials.credentialType === "api_token") {
        protocols.push(`authorization.bearer.${credentials.token}`);
      }
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
        heartbeatSubscription = interval(30_000).subscribe(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ version: 1, type: "heartbeat" }));
          }
        });
      });
      socket.addEventListener("error", () => socket.close());
      socket.addEventListener("close", () => {
        if (recordingClientSocketRef.current !== socket) {
          return;
        }
        recordingClientSocketRef.current = null;
        recordingClientIdRef.current = null;
        setRecordingClientConnected(false);
        heartbeatSubscription?.unsubscribe();
        heartbeatSubscription = null;
        if (active) {
          retrySubscription = timer(1000).subscribe(connect);
        }
      });
    };

    connect();
    return () => {
      active = false;
      retrySubscription?.unsubscribe();
      heartbeatSubscription?.unsubscribe();
      const socket = recordingClientSocketRef.current;
      recordingClientSocketRef.current = null;
      recordingClientIdRef.current = null;
      setRecordingClientConnected(false);
      socket?.close();
    };
  }, [enabled, sessionId, credentials, sessionToken, recordingTenantId, collaborationRole]);

  useEffect(() => {
    const socket = recordingClientSocketRef.current;
    const targetId = recordingTargetIdRef.current;
    if (socket?.readyState === WebSocket.OPEN && targetId) {
      socket.send(JSON.stringify({ version: 1, type: "target.select", targetId }));
    }
  }, [activeTargetId, controlState.mediaTargetId]);

  useEffect(() => {
    if (!enabled || !sessionId || !credentials || collaborationRole !== "owner") {
      return;
    }
    let active = true;
    const refresh = () => {
      void apiClient
        .listSessionRecordings(credentials, sessionId, sessionToken)
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
  }, [enabled, sessionId, credentials, sessionToken, collaborationRole]);

  const recordingPollingActive = recordings.some(
    (recording) => recording.status === "starting" || recording.status === "running",
  );

  useEffect(() => {
    if (
      !enabled ||
      !sessionId ||
      !credentials ||
      collaborationRole !== "owner" ||
      !recordingPollingActive
    ) {
      return;
    }
    let active = true;
    const subscription = interval(2000).subscribe(() => {
      void apiClient
        .listSessionRecordings(credentials, sessionId, sessionToken)
        .then((nextRecordings) => {
          if (active) {
            setRecordings(nextRecordings);
          }
        })
        .catch(() => undefined);
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [enabled, sessionId, credentials, sessionToken, collaborationRole, recordingPollingActive]);

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

  return {
    phase: controlState.phase,
    targets,
    activeTargetId,
    activeTarget,
    frame$,
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
    remoteCursorEnabled,
    remoteCursorBusy,
    collaboration,
    setCaptured,
    setInputDimensions,
    setViewport: applyViewport,
    setBrowserViewportSize,
    setViewportAutoSync,
    setViewportToBrowserSize,
    setWebRTCStreamSettings,
    selectMediaStream,
    send,
    activateTarget,
    reorderTargets,
    createTarget,
    duplicateTarget,
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
    setRemoteCursorEnabled,
    reconnect,
  };
}

function isBrowserInputMessage(message: ClientMessage): message is Extract<
  ClientMessage,
  {
    type:
      | "input.mouse"
      | "input.wheel"
      | "input.key"
      | "clipboard.copy"
      | "clipboard.cut"
      | "clipboard.paste";
  }
> {
  return (
    message.type === "input.mouse" ||
    message.type === "input.wheel" ||
    message.type === "input.key" ||
    message.type === "clipboard.copy" ||
    message.type === "clipboard.cut" ||
    message.type === "clipboard.paste"
  );
}

function browserMessageAllowed(message: ClientMessage, role: CollaborationRole) {
  switch (message.type) {
    case "targets.list":
    case "targets.activate":
    case "screencast.start":
    case "screencast.stop":
      return true;
    case "input.mouse":
    case "input.wheel":
    case "input.key":
    case "clipboard.copy":
    case "clipboard.cut":
    case "clipboard.paste":
      return false;
    default:
      return role !== "viewer";
  }
}
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  timer(0).subscribe(() => URL.revokeObjectURL(url));
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

function isBrowserControlFrameOutput(
  output: BrowserControlOutput,
): output is Extract<BrowserControlOutput, { type: "frame" }> {
  return output.type === "frame";
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
