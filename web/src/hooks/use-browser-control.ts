import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { timer, type Observable } from "rxjs";
import { toast } from "sonner";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import {
  useLiveSession,
  type CollaborationControl,
  type LiveSessionMediaSelection,
} from "#/hooks/use-live-session.ts";
import { apiClient, type ApiCredentials } from "#/lib/api/client.ts";
import type { Recording } from "#/lib/api/schemas.ts";
import type {
  ClientMessage,
  ControlConnectionPhase,
  ControlError,
  ControlTarget,
  ScreencastFrame,
} from "#/lib/control/messages.ts";
import type {
  CollaborationRole,
  LiveSessionPresentation,
  LiveSessionPresentationQuality,
} from "#/lib/control/live-session-protocol.ts";
import {
  createViewportPreset,
  DEFAULT_VIEWPORT,
  type ViewportPreset,
} from "#/lib/control/viewport.ts";

type UseBrowserControlOptions = {
  sessionId: string | null;
  credentials?: ApiCredentials;
  sessionToken?: string;
  collaborationRole?: CollaborationRole;
  enabled?: boolean;
  webrtcProducerSupported?: boolean;
  webrtcIceServers?: RTCIceServer[];
};

type BrowserViewportSize = {
  width: number;
  height: number;
};

export type BrowserMediaPath = "webrtc-live" | "websocket-live";
export type BrowserMediaPhase = "idle" | "connecting" | "live" | "failed";

export type UseBrowserControlResult = {
  phase: ControlConnectionPhase;
  targets: ControlTarget[];
  activeTargetId: string | null;
  activeTarget: ControlTarget | null;
  frame$: Observable<ScreencastFrame | null>;
  mediaPhase: BrowserMediaPhase;
  mediaStream: MediaStream | null;
  mediaStreamSettings: LiveSessionPresentationQuality | null;
  mediaVideoProfiles: LiveSessionPresentation["profiles"];
  mediaSize: {
    width: number;
    height: number;
    deviceScaleFactor: number;
    canvasWidth: number;
    canvasHeight: number;
  } | null;
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
  setWebRTCStreamSettings: (settings: LiveSessionPresentationQuality) => boolean;
  selectMediaStream: (selection: LiveSessionMediaSelection) => boolean;
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
}: UseBrowserControlOptions): UseBrowserControlResult {
  const profileCredentials = useApiCredentials();
  const credentials = credentialsOverride ?? profileCredentials;
  const live = useLiveSession({
    sessionId,
    credentials,
    sessionToken,
    role: collaborationRole,
    enabled: Boolean(enabled && sessionId && credentials),
    webrtcSupported: webrtcProducerSupported,
    iceServers: webrtcIceServers,
  });
  const [targets, setTargets] = useState<ControlTarget[]>([]);
  const [viewport, setViewportState] = useState<ViewportPreset>(DEFAULT_VIEWPORT);
  const [browserViewportSize, setBrowserViewportSizeState] = useState<BrowserViewportSize | null>(
    null,
  );
  const [viewportAutoSync, setViewportAutoSyncState] = useState(false);
  const [captured, setCaptured] = useState(false);
  const [recordingBusy, setRecordingBusy] = useState(false);
  const [remoteCursorEnabled, setRemoteCursorEnabledState] = useState(true);
  const [remoteCursorBusy, setRemoteCursorBusy] = useState(false);
  const activeTargetIdRef = useRef<string | null>(null);
  const viewportRef = useRef(viewport);
  const inputDimensionsRef = useRef<BrowserViewportSize>(DEFAULT_VIEWPORT);
  const browserViewportSizeRef = useRef<BrowserViewportSize | null>(null);
  const viewportAutoSyncRef = useRef(false);

  activeTargetIdRef.current = live.activeTargetId;
  viewportRef.current = viewport;
  browserViewportSizeRef.current = browserViewportSize;
  viewportAutoSyncRef.current = viewportAutoSync;

  useEffect(() => {
    setTargets((current) => mergeTargetsInCurrentOrder(current, live.targets));
    if (live.phase !== "connected") {
      setCaptured(false);
    }
  }, [live.phase, live.targets]);

  useEffect(() => {
    if (!live.mediaSize) {
      return;
    }
    const current = viewportRef.current;
    if (
      current.width === live.mediaSize.width &&
      current.height === live.mediaSize.height &&
      current.deviceScaleFactor === live.mediaSize.deviceScaleFactor
    ) {
      return;
    }
    setViewportState(createBrowserViewport(live.mediaSize, live.mediaSize.deviceScaleFactor));
  }, [live.mediaSize]);

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
  }, [credentials, enabled, sessionId, sessionToken]);

  const send = useCallback(
    (message: ClientMessage): boolean => {
      if (!enabled || !sessionId || !credentials) {
        return false;
      }
      if (isBrowserInputMessage(message)) {
        return live.sendBrowserInput(message, inputDimensionsRef.current);
      }
      switch (message.type) {
        case "targets.activate":
          return live.selectTarget(message.targetId);
        case "targets.create":
          return live.command("target.create", message.url ? { url: message.url } : {});
        case "targets.close":
          return live.command("target.close", { targetId: message.targetId });
        case "page.navigate":
          return live.command("page.navigate", { targetId: message.targetId, url: message.url });
        case "page.historyBack":
          return live.command("page.history-back", { targetId: message.targetId });
        case "page.historyForward":
          return live.command("page.history-forward", { targetId: message.targetId });
        case "page.reload":
          return live.command("page.reload", { targetId: message.targetId });
        case "page.stopLoading":
          return live.command("page.stop-loading", { targetId: message.targetId });
        case "viewport.set":
          return live.command("viewport.set", {
            targetId: message.targetId,
            width: message.width,
            height: message.height,
            deviceScaleFactor: message.deviceScaleFactor ?? 1,
          });
        case "targets.list":
        case "screencast.start":
        case "screencast.stop":
          return false;
        default: {
          const exhaustive: never = message;
          return exhaustive;
        }
      }
    },
    [credentials, enabled, live, sessionId],
  );

  const sendForActive = useCallback(
    (build: (targetId: string) => ClientMessage) => {
      const targetId = activeTargetIdRef.current;
      return targetId ? send(build(targetId)) : false;
    },
    [send],
  );

  const activateTarget = useCallback(
    (targetId: string) => {
      live.selectTarget(targetId);
    },
    [live],
  );

  const reorderTargets = useCallback(
    (sourceTargetId: string, destinationTargetId: string, placement: "before" | "after") => {
      if (sourceTargetId === destinationTargetId) {
        return;
      }
      setTargets((current) => {
        const sourceIndex = current.findIndex((target) => target.id === sourceTargetId);
        const destinationIndex = current.findIndex((target) => target.id === destinationTargetId);
        const source = current[sourceIndex];
        if (sourceIndex === -1 || destinationIndex === -1 || !source) {
          return current;
        }
        const next = [...current];
        next.splice(sourceIndex, 1);
        const requestedIndex = placement === "after" ? destinationIndex + 1 : destinationIndex;
        const nextIndex = sourceIndex < requestedIndex ? requestedIndex - 1 : requestedIndex;
        if (nextIndex === sourceIndex) {
          return current;
        }
        next.splice(nextIndex, 0, source);
        return next;
      });
    },
    [],
  );

  const createAndSelectTarget = useCallback(
    async (url: string) => {
      try {
        const result = await live.request("target.create", { url });
        return result.targetId ?? null;
      } catch (cause: unknown) {
        toast.error(errorMessage(cause, "Tab could not be created"));
        return null;
      }
    },
    [live],
  );

  const createTarget = useCallback(
    (url = "about:blank") => {
      void createAndSelectTarget(url);
    },
    [createAndSelectTarget],
  );

  const duplicateTarget = useCallback(
    (target: ControlTarget) => {
      void createAndSelectTarget(target.url || "about:blank").then((targetId) => {
        if (targetId) {
          reorderTargets(targetId, target.id, "after");
        }
      });
    },
    [createAndSelectTarget, reorderTargets],
  );

  const closeTarget = useCallback(
    (targetId: string) => {
      live.command("target.close", { targetId });
    },
    [live],
  );

  const navigate = useCallback(
    (url: string) => {
      sendForActive((targetId) => ({ type: "page.navigate", targetId, url }));
    },
    [sendForActive],
  );

  const reload = useCallback(
    (targetId: string) => {
      live.command("page.reload", { targetId });
    },
    [live],
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

  const commitViewport = useCallback(
    (preset: ViewportPreset) => {
      setViewportState(preset);
      const targetId = activeTargetIdRef.current;
      if (targetId) {
        live.command("viewport.set", {
          targetId,
          width: preset.width,
          height: preset.height,
          deviceScaleFactor: preset.deviceScaleFactor,
        });
      }
    },
    [live],
  );

  const setViewport = useCallback(
    (preset: ViewportPreset) => {
      viewportAutoSyncRef.current = false;
      setViewportAutoSyncState(false);
      commitViewport(preset);
    },
    [commitViewport],
  );

  const setBrowserViewportSize = useCallback(
    (size: BrowserViewportSize) => {
      const next = { width: Math.round(size.width), height: Math.round(size.height) };
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
    (nextEnabled: boolean) => {
      viewportAutoSyncRef.current = nextEnabled;
      setViewportAutoSyncState(nextEnabled);
      const size = browserViewportSizeRef.current;
      if (nextEnabled && size) {
        commitViewport(createBrowserViewport(size, viewportRef.current.deviceScaleFactor));
      }
    },
    [commitViewport],
  );

  const setViewportToBrowserSize = useCallback(() => {
    const size = browserViewportSizeRef.current;
    if (!size) {
      return;
    }
    viewportAutoSyncRef.current = false;
    setViewportAutoSyncState(false);
    commitViewport(createBrowserViewport(size, viewportRef.current.deviceScaleFactor));
  }, [commitViewport]);

  const startRecording = useCallback(
    (mode: "tab" | "viewer") => {
      const targetId = activeTargetIdRef.current;
      if (!targetId || collaborationRole !== "owner" || recordingBusy) {
        return;
      }
      setRecordingBusy(true);
      void live
        .request("recording.start", { mode, targetId })
        .catch((cause: unknown) => toast.error(errorMessage(cause, "Recording failed to start")))
        .finally(() => setRecordingBusy(false));
    },
    [collaborationRole, live, recordingBusy],
  );

  const stopRecording = useCallback(
    (recordingId: string) => {
      if (!sessionId || !credentials || recordingBusy) {
        return;
      }
      setRecordingBusy(true);
      void live
        .request("recording.stop", { recordingId })
        .then(() =>
          apiClient.downloadSessionRecording(credentials, sessionId, recordingId, sessionToken),
        )
        .then(({ blob, filename }) => {
          const recording = live.recordings.find(
            (candidate) => candidate.recordingId === recordingId,
          );
          downloadBlob(
            blob,
            filename ?? `${sessionId}-${recording?.targetId ?? "target"}-${recordingId}.webm`,
          );
          toast.success("Recording saved");
        })
        .catch((cause: unknown) => toast.error(errorMessage(cause, "Recording failed to stop")))
        .finally(() => setRecordingBusy(false));
    },
    [credentials, live, recordingBusy, sessionId, sessionToken],
  );

  const cancelRecording = useCallback(
    (recordingId: string) => {
      if (recordingBusy) {
        return;
      }
      setRecordingBusy(true);
      void live
        .request("recording.cancel", { recordingId })
        .then(() => toast.success("Recording stopped"))
        .catch((cause: unknown) => toast.error(errorMessage(cause, "Recording failed to stop")))
        .finally(() => setRecordingBusy(false));
    },
    [live, recordingBusy],
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
    [credentials, remoteCursorBusy, sessionId, sessionToken],
  );

  const selectMediaStream = useCallback(
    (selection: LiveSessionMediaSelection) => {
      if (!enabled || !sessionId || !credentials || live.mediaSwitching) {
        return false;
      }
      void live
        .selectPresentation(selection)
        .catch((cause: unknown) =>
          toast.error(errorMessage(cause, "Presentation could not be updated")),
        );
      return true;
    },
    [credentials, enabled, live, sessionId],
  );

  const setWebRTCStreamSettings = useCallback(
    (settings: LiveSessionPresentationQuality) =>
      selectMediaStream({ kind: "webrtc", quality: settings }),
    [selectMediaStream],
  );

  const activeTarget = useMemo(
    () => targets.find((target) => target.id === live.activeTargetId) ?? null,
    [live.activeTargetId, targets],
  );
  const mediaPath: BrowserMediaPath =
    live.transport === "webrtc" ? "webrtc-live" : "websocket-live";
  const mediaPhase: BrowserMediaPhase =
    live.phase === "connected"
      ? "live"
      : live.phase === "connecting"
        ? "connecting"
        : live.phase === "error"
          ? "failed"
          : "idle";

  return {
    phase: live.phase,
    targets,
    activeTargetId: live.activeTargetId,
    activeTarget,
    frame$: live.frame$,
    mediaPhase,
    mediaStream: live.mediaStream,
    mediaStreamSettings: live.presentation?.quality ?? null,
    mediaVideoProfiles: live.presentation?.profiles ?? [],
    mediaSize: live.mediaSize,
    mediaError: null,
    mediaPath,
    mediaTargetId: live.activeTargetId,
    mediaSwitching: live.mediaSwitching,
    lastError: null,
    viewport,
    browserViewportSize,
    viewportAutoSync,
    captured,
    recordings: live.recordings,
    recordingBusy,
    recordingClientConnected: collaborationRole === "owner" && live.phase === "connected",
    remoteCursorEnabled,
    remoteCursorBusy,
    collaboration: live.collaboration,
    setCaptured,
    setInputDimensions: (size) => {
      inputDimensionsRef.current = size;
    },
    setViewport,
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
    startScreencast: live.reconnect,
    startRecording,
    stopRecording,
    cancelRecording,
    setRemoteCursorEnabled,
    reconnect: live.reconnect,
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
