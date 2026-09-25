import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  useLiveSession,
  type CollaborationControl,
  type LiveSessionControl,
  type LiveSessionMediaSelection,
} from "./use-live-session.ts";
import { SessionsApi, type ApiCredentials, type IceServer } from "@aperture-browser/api-client";
import type { Recording } from "@aperture-browser/api-client";
import { LiveSessionError, type BrowserInputMessage } from "@aperture-browser/live-session";
import type {
  CollaborationRole,
  LiveSessionPresentation,
  LiveSessionPresentationQuality,
  LiveSessionRasterFrame,
  LiveSessionTarget,
} from "@aperture-browser/live-session";
import {
  createViewportPreset,
  DEFAULT_VIEWPORT,
  type ViewportPreset,
} from "@aperture-browser/live-session";
import { useEffectCallback, useRuntime } from "../effect.tsx";

export interface SessionNotice {
  readonly level: "error" | "success";
  readonly message: string;
}

interface UseBrowserControlOptions {
  sessionId: string | null;
  credentials: ApiCredentials | null;
  displayName?: string | null;
  sessionToken?: string;
  collaborationRole?: CollaborationRole;
  enabled?: boolean;
  webrtcProducerSupported?: boolean;
  webrtcIceServers?: readonly IceServer[];
  onNotice?: (notice: SessionNotice) => void;
}

interface BrowserViewportSize {
  width: number;
  height: number;
}

export interface BrowserCommands {
  readonly navigate: (url: string) => Effect.Effect<void, LiveSessionError>;
  readonly historyBack: () => Effect.Effect<void, LiveSessionError>;
  readonly historyForward: () => Effect.Effect<void, LiveSessionError>;
  readonly reload: (targetId?: string) => Effect.Effect<void, LiveSessionError>;
  readonly stopLoading: () => Effect.Effect<void, LiveSessionError>;
  readonly createTarget: (url?: string) => Effect.Effect<string | null, LiveSessionError>;
  readonly closeTarget: (targetId: string) => Effect.Effect<void, LiveSessionError>;
  readonly activateTarget: (targetId: string) => Effect.Effect<void, LiveSessionError>;
}

export type BrowserMediaPath = "webrtc-live" | "websocket-live";
export type BrowserMediaPhase = "idle" | "connecting" | "live" | "failed";

export interface UseBrowserControlResult {
  phase: LiveSessionControl["phase"];
  targets: readonly LiveSessionTarget[];
  activeTargetId: string | null;
  activeTarget: LiveSessionTarget | null;
  frames: Stream.Stream<LiveSessionRasterFrame | null>;
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
  mediaPath: BrowserMediaPath;
  mediaTargetId: string | null;
  mediaSwitching: boolean;
  viewport: ViewportPreset;
  browserViewportSize: BrowserViewportSize | null;
  viewportAutoSync: boolean;
  captured: boolean;
  recordings: readonly Recording[];
  recordingBusy: boolean;
  remoteCursorEnabled: boolean;
  collaboration: CollaborationControl;
  commands: BrowserCommands;
  setCaptured: (captured: boolean) => void;
  setInputDimensions: (size: BrowserViewportSize) => void;
  setViewport: (viewport: ViewportPreset) => void;
  setBrowserViewportSize: (size: BrowserViewportSize) => void;
  setViewportAutoSync: (enabled: boolean) => void;
  setViewportToBrowserSize: () => void;
  setWebRTCStreamSettings: (settings: LiveSessionPresentationQuality) => boolean;
  selectMediaStream: (selection: LiveSessionMediaSelection) => boolean;
  sendInput: (message: BrowserInputMessage) => boolean;
  activateTarget: (targetId: string) => void;
  reorderTargets: (
    sourceTargetId: string,
    destinationTargetId: string,
    placement: "before" | "after",
  ) => void;
  createTarget: (url?: string) => void;
  duplicateTarget: (target: LiveSessionTarget) => void;
  closeTarget: (targetId: string) => void;
  navigate: (url: string) => void;
  reload: (targetId: string) => void;
  stopLoading: () => void;
  historyBack: () => void;
  historyForward: () => void;
  startRecording: (mode: "tab" | "viewer") => void;
  stopRecording: (recordingId: string) => void;
  cancelRecording: (recordingId: string) => void;
  setRemoteCursorEnabled: (enabled: boolean) => void;
  reconnect: () => void;
}

const emptyIceServers: readonly IceServer[] = [];

export function useBrowserControl({
  sessionId,
  credentials,
  displayName,
  sessionToken,
  collaborationRole = "owner",
  enabled = true,
  webrtcProducerSupported = false,
  webrtcIceServers = emptyIceServers,
  onNotice,
}: UseBrowserControlOptions): UseBrowserControlResult {
  const runtime = useRuntime();
  const onNoticeRef = useRef(onNotice);
  onNoticeRef.current = onNotice;
  const notify = (level: SessionNotice["level"], message: string) =>
    Effect.sync(() => onNoticeRef.current?.({ level, message }));
  const live = useLiveSession({
    sessionId,
    displayName,
    credentials,
    sessionToken,
    role: collaborationRole,
    enabled: Boolean(enabled && sessionId && credentials),
    webrtcSupported: webrtcProducerSupported,
    iceServers: webrtcIceServers,
  });
  const [targetOrder, setTargetOrder] = useState<readonly string[]>([]);
  const targets = useMemo(
    () => mergeTargetsInCurrentOrder(targetOrder, live.targets),
    [live.targets, targetOrder],
  );
  const liveTargetsRef = useRef(live.targets);
  liveTargetsRef.current = live.targets;
  const phaseRef = useRef(live.phase);
  phaseRef.current = live.phase;
  const [viewport, setViewportState] = useState<ViewportPreset>(DEFAULT_VIEWPORT);
  const [browserViewportSize, setBrowserViewportSizeState] = useState<BrowserViewportSize | null>(
    null,
  );
  const [viewportAutoSync, setViewportAutoSyncState] = useState(false);
  const [captured, setCaptured] = useState(false);
  const [recordingBusy, setRecordingBusy] = useState(false);
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
    if (live.phase !== "connected") {
      setCaptured(false);
    }
  }, [live.phase]);

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

  const sendInput = useCallback(
    (message: BrowserInputMessage): boolean => {
      if (!enabled || !sessionId || !credentials) {
        return false;
      }
      return live.sendBrowserInput(message, inputDimensionsRef.current);
    },
    [credentials, enabled, live, sessionId],
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
      setTargetOrder((order) => {
        const current = mergeTargetsInCurrentOrder(order, liveTargetsRef.current).map(
          (target) => target.id,
        );
        const sourceIndex = current.indexOf(sourceTargetId);
        const destinationIndex = current.indexOf(destinationTargetId);
        const source = current[sourceIndex];
        if (sourceIndex === -1 || destinationIndex === -1 || !source) {
          return order;
        }
        const next = [...current];
        next.splice(sourceIndex, 1);
        const requestedIndex = placement === "after" ? destinationIndex + 1 : destinationIndex;
        const nextIndex = sourceIndex < requestedIndex ? requestedIndex - 1 : requestedIndex;
        if (nextIndex === sourceIndex) {
          return order;
        }
        next.splice(nextIndex, 0, source);
        return next;
      });
    },
    [],
  );

  const createAndSelectTarget = useCallback(
    (url: string) =>
      runtime.runPromise(
        live.request("target.create", { url }).pipe(
          Effect.map((result) => result.targetId ?? null),
          Effect.catch((error) =>
            notify("error", errorMessage(error, "Tab could not be created")).pipe(Effect.as(null)),
          ),
        ),
      ),
    [live, runtime],
  );

  const createTarget = useCallback(
    (url = "about:blank") => {
      void createAndSelectTarget(url);
    },
    [createAndSelectTarget],
  );

  const duplicateTarget = useCallback(
    (target: LiveSessionTarget) => {
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
      const targetId = activeTargetIdRef.current;
      if (targetId) {
        live.command("page.navigate", { targetId, url });
      }
    },
    [live],
  );

  const reload = useCallback(
    (targetId: string) => {
      live.command("page.reload", { targetId });
    },
    [live],
  );

  const stopLoading = useCallback(() => {
    const targetId = activeTargetIdRef.current;
    if (targetId) {
      live.command("page.stop-loading", { targetId });
    }
  }, [live]);

  const historyBack = useCallback(() => {
    const targetId = activeTargetIdRef.current;
    if (targetId) {
      live.command("page.history-back", { targetId });
    }
  }, [live]);

  const historyForward = useCallback(() => {
    const targetId = activeTargetIdRef.current;
    if (targetId) {
      live.command("page.history-forward", { targetId });
    }
  }, [live]);

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

  const settleRecording = <A, E extends Error>(
    effect: Effect.Effect<A, E, SessionsApi>,
    failure: string,
  ) =>
    effect.pipe(
      Effect.catch((error) => notify("error", errorMessage(error, failure))),
      Effect.ensuring(Effect.sync(() => setRecordingBusy(false))),
    );

  const runStartRecording = useEffectCallback(
    (mode: "tab" | "viewer", targetId: string) =>
      settleRecording(
        live.request("recording.start", { mode, targetId }),
        "Recording failed to start",
      ),
    [live],
  );
  const startRecording = useCallback(
    (mode: "tab" | "viewer") => {
      const targetId = activeTargetIdRef.current;
      if (!targetId || collaborationRole !== "owner" || recordingBusy) {
        return;
      }
      setRecordingBusy(true);
      runStartRecording(mode, targetId);
    },
    [collaborationRole, recordingBusy, runStartRecording],
  );

  const runStopRecording = useEffectCallback(
    (credentials: ApiCredentials, sessionId: string, recordingId: string) =>
      settleRecording(
        live.request("recording.stop", { recordingId }).pipe(
          Effect.andThen(
            SessionsApi.use((sessions) =>
              sessions.downloadSessionRecording(credentials, sessionId, recordingId, sessionToken),
            ),
          ),
          Effect.flatMap(({ blob, filename }) => {
            const recording = live.recordings.find(
              (candidate) => candidate.recordingId === recordingId,
            );
            return downloadBlob(
              blob,
              filename ?? `${sessionId}-${recording?.targetId ?? "target"}-${recordingId}.webm`,
            );
          }),
          Effect.andThen(notify("success", "Recording saved")),
        ),
        "Recording failed to stop",
      ),
    [live, sessionToken],
  );
  const stopRecording = useCallback(
    (recordingId: string) => {
      if (!sessionId || !credentials || recordingBusy) {
        return;
      }
      setRecordingBusy(true);
      runStopRecording(credentials, sessionId, recordingId);
    },
    [credentials, recordingBusy, runStopRecording, sessionId],
  );

  const runCancelRecording = useEffectCallback(
    (recordingId: string) =>
      settleRecording(
        live
          .request("recording.cancel", { recordingId })
          .pipe(Effect.andThen(notify("success", "Recording stopped"))),
        "Recording failed to stop",
      ),
    [live],
  );
  const cancelRecording = useCallback(
    (recordingId: string) => {
      if (recordingBusy) {
        return;
      }
      setRecordingBusy(true);
      runCancelRecording(recordingId);
    },
    [recordingBusy, runCancelRecording],
  );

  const runSetRemoteCursor = useEffectCallback(
    (visible: boolean) =>
      live
        .request("presentation.cursor.set", { visible })
        .pipe(
          Effect.catch((error) =>
            notify("error", errorMessage(error, "Remote cursor could not be updated")),
          ),
        ),
    [live],
  );
  const setRemoteCursorEnabled = useCallback(
    (visible: boolean) => {
      if (sessionId && credentials) {
        runSetRemoteCursor(visible);
      }
    },
    [credentials, runSetRemoteCursor, sessionId],
  );

  const runSelectPresentation = useEffectCallback(
    (selection: LiveSessionMediaSelection) =>
      live
        .selectPresentation(selection)
        .pipe(
          Effect.catch((error) =>
            notify("error", errorMessage(error, "Presentation could not be updated")),
          ),
        ),
    [live],
  );
  const selectMediaStream = useCallback(
    (selection: LiveSessionMediaSelection) => {
      if (!enabled || !sessionId || !credentials || live.mediaSwitching) {
        return false;
      }
      runSelectPresentation(selection);
      return true;
    },
    [credentials, enabled, live.mediaSwitching, runSelectPresentation, sessionId],
  );

  const setWebRTCStreamSettings = useCallback(
    (settings: LiveSessionPresentationQuality) =>
      selectMediaStream({ kind: "webrtc", quality: settings }),
    [selectMediaStream],
  );

  const commands = useMemo<BrowserCommands>(() => {
    const connected = <A>(effect: Effect.Effect<A, LiveSessionError>) =>
      Effect.suspend(() =>
        phaseRef.current === "connected"
          ? effect
          : Effect.fail(new LiveSessionError({ message: "the session is not connected" })),
      );
    const request = (type: string, payload: Record<string, unknown>) =>
      connected(live.request(type, payload));
    const onActiveTarget = (type: string, payload: Record<string, unknown> = {}) =>
      connected(
        Effect.suspend(() => {
          const targetId = activeTargetIdRef.current;
          return targetId
            ? live.request(type, { targetId, ...payload })
            : Effect.fail(new LiveSessionError({ message: "no tab is active" }));
        }),
      ).pipe(Effect.asVoid);
    return {
      navigate: (url) => onActiveTarget("page.navigate", { url }),
      historyBack: () => onActiveTarget("page.history-back"),
      historyForward: () => onActiveTarget("page.history-forward"),
      reload: (targetId) =>
        targetId
          ? request("page.reload", { targetId }).pipe(Effect.asVoid)
          : onActiveTarget("page.reload"),
      stopLoading: () => onActiveTarget("page.stop-loading"),
      createTarget: (url = "about:blank") =>
        request("target.create", { url }).pipe(Effect.map((result) => result.targetId ?? null)),
      closeTarget: (targetId) => request("target.close", { targetId }).pipe(Effect.asVoid),
      activateTarget: (targetId) => connected(live.requestSelectTarget(targetId)),
    };
  }, [live.request, live.requestSelectTarget]);

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
    frames: live.frames,
    mediaPhase,
    mediaStream: live.mediaStream,
    mediaStreamSettings: live.presentation?.quality ?? null,
    mediaVideoProfiles: live.presentation?.profiles ?? [],
    mediaSize: live.mediaSize,
    mediaPath,
    mediaTargetId: live.activeTargetId,
    mediaSwitching: live.mediaSwitching,
    viewport,
    browserViewportSize,
    viewportAutoSync,
    captured,
    recordings: live.recordings,
    recordingBusy,
    remoteCursorEnabled: live.presentation?.cursorVisible ?? true,
    collaboration: live.collaboration,
    commands,
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
    sendInput,
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
    startRecording,
    stopRecording,
    cancelRecording,
    setRemoteCursorEnabled,
    reconnect: live.reconnect,
  };
}

function mergeTargetsInCurrentOrder(
  order: readonly string[],
  nextTargets: readonly LiveSessionTarget[],
): LiveSessionTarget[] {
  const nextById = new Map(nextTargets.map((target) => [target.id, target]));
  const seen = new Set<string>();
  const ordered: LiveSessionTarget[] = [];
  for (const targetId of order) {
    const nextTarget = nextById.get(targetId);
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

// The object URL is released once the browser has started the download.
const downloadBlob = (blob: Blob, filename: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => URL.createObjectURL(blob)),
    (url) =>
      Effect.sync(() => {
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.click();
      }),
    (url) => Effect.sync(() => URL.revokeObjectURL(url)).pipe(Effect.delay(0)),
  );

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}
