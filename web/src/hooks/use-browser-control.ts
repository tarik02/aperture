import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { BrowserControlConnection } from "#/lib/control/connection.ts";
import { useWebRTCMedia, type WebRTCMediaPhase } from "#/hooks/use-webrtc-media.ts";
import type {
  ClientMessage,
  ControlConnectionPhase,
  ControlError,
  ControlTarget,
  ScreencastFrame,
} from "#/lib/control/messages.ts";
import { DEFAULT_VIEWPORT, type ViewportPreset } from "#/lib/control/viewport.ts";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";

type UseBrowserControlOptions = {
  sessionId: string | null;
  enabled?: boolean;
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
  mediaError: string | null;
  lastError: ControlError | null;
  viewport: ViewportPreset;
  browserViewportSize: BrowserViewportSize | null;
  viewportAutoSync: boolean;
  captured: boolean;
  setCaptured: (captured: boolean) => void;
  setViewport: (viewport: ViewportPreset) => void;
  setBrowserViewportSize: (size: BrowserViewportSize) => void;
  setViewportAutoSync: (enabled: boolean) => void;
  setViewportToBrowserSize: () => void;
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
  reconnect: () => void;
};

export function useBrowserControl({
  sessionId,
  enabled = true,
}: UseBrowserControlOptions): UseBrowserControlResult {
  const credentials = useApiCredentials();
  const [phase, setPhase] = useState<ControlConnectionPhase>("idle");
  const [targets, setTargets] = useState<ControlTarget[]>([]);
  const [activeTargetId, setActiveTargetId] = useState<string | null>(null);
  const [frame, setFrame] = useState<ScreencastFrame | null>(null);
  const [frameStale, setFrameStale] = useState(false);
  const [lastError, setLastError] = useState<ControlError | null>(null);
  const [viewport, setViewport] = useState<ViewportPreset>(DEFAULT_VIEWPORT);
  const [browserViewportSize, setBrowserViewportSizeState] = useState<BrowserViewportSize | null>(
    null,
  );
  const [viewportAutoSync, setViewportAutoSyncState] = useState(false);
  const [captured, setCaptured] = useState(false);

  const connectionRef = useRef<BrowserControlConnection | null>(null);
  const activeTargetIdRef = useRef<string | null>(null);
  const screencastTargetIdRef = useRef<string | null>(null);
  const viewportRef = useRef(viewport);
  const browserViewportSizeRef = useRef<BrowserViewportSize | null>(null);
  const viewportAutoSyncRef = useRef(false);
  const mediaPhaseRef = useRef<WebRTCMediaPhase>("idle");
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const webrtcPreferredRef = useRef(false);

  activeTargetIdRef.current = activeTargetId;
  viewportRef.current = viewport;
  browserViewportSizeRef.current = browserViewportSize;
  viewportAutoSyncRef.current = viewportAutoSync;
  webrtcPreferredRef.current = Boolean(enabled && sessionId && credentials);

  const webrtcMedia = useWebRTCMedia({
    sessionId,
    credentials,
    enabled: enabled && phase === "connected",
  });
  mediaPhaseRef.current = webrtcMedia.phase;
  mediaStreamRef.current = webrtcMedia.stream;

  const activeTarget = useMemo(
    () => targets.find((target) => target.id === activeTargetId) ?? null,
    [targets, activeTargetId],
  );

  const send = useCallback((message: ClientMessage) => {
    return connectionRef.current?.send(message) ?? false;
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
    sendForActive((targetId) => ({
      type: "input.key",
      targetId,
      action: "down",
      key: "ArrowLeft",
      code: "ArrowLeft",
      modifiers: 1,
    }));
    sendForActive((targetId) => ({
      type: "input.key",
      targetId,
      action: "up",
      key: "ArrowLeft",
      code: "ArrowLeft",
      modifiers: 1,
    }));
  }, [sendForActive]);

  const historyForward = useCallback(() => {
    sendForActive((targetId) => ({
      type: "input.key",
      targetId,
      action: "down",
      key: "ArrowRight",
      code: "ArrowRight",
      modifiers: 1,
    }));
    sendForActive((targetId) => ({
      type: "input.key",
      targetId,
      action: "up",
      key: "ArrowRight",
      code: "ArrowRight",
      modifiers: 1,
    }));
  }, [sendForActive]);

  const startScreencast = useCallback(() => {
    const targetId = activeTargetIdRef.current ?? undefined;
    screencastTargetIdRef.current = targetId ?? null;
    send({
      type: "screencast.start",
      targetId,
      format: "jpeg",
      quality: 80,
      maxWidth: viewportRef.current.width,
      maxHeight: viewportRef.current.height,
    });
  }, [send]);

  const shouldWaitForWebRTC = useCallback(() => {
    if (!webrtcPreferredRef.current || mediaPhaseRef.current === "failed") {
      return false;
    }
    return mediaPhaseRef.current !== "live" || Boolean(mediaStreamRef.current);
  }, []);

  const applyViewport = useCallback(
    (preset: ViewportPreset) => {
      setViewport(preset);
      sendForActive((targetId) => ({
        type: "viewport.set",
        targetId,
        width: preset.width,
        height: preset.height,
        deviceScaleFactor: 1,
      }));
    },
    [sendForActive],
  );

  const setViewportToBrowserSize = useCallback(() => {
    const size = browserViewportSizeRef.current;
    if (!size) {
      return;
    }
    applyViewport(createBrowserViewport(size));
  }, [applyViewport]);

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
        applyViewport(createBrowserViewport(next));
      }
    },
    [applyViewport],
  );

  const setViewportAutoSync = useCallback(
    (enabled: boolean) => {
      viewportAutoSyncRef.current = enabled;
      setViewportAutoSyncState(enabled);
      if (enabled) {
        setViewportToBrowserSize();
      }
    },
    [setViewportToBrowserSize],
  );

  const reconnect = useCallback(() => {
    if (!sessionId || !credentials) {
      return;
    }
    connectionRef.current?.connect(sessionId, credentials);
  }, [sessionId, credentials]);

  useEffect(() => {
    if (!enabled || !sessionId || !credentials) {
      setPhase("idle");
      setTargets([]);
      setActiveTargetId(null);
      setFrame(null);
      setCaptured(false);
      connectionRef.current?.close();
      connectionRef.current = null;
      screencastTargetIdRef.current = null;
      return;
    }

    const connection = new BrowserControlConnection({
      onPhaseChange: (next) => {
        setPhase(next);
        if (next === "connected") {
          setLastError(null);
          connection.send({ type: "targets.list" });
        }
        if (next === "disconnected" || next === "error") {
          setFrame(null);
          setCaptured(false);
          screencastTargetIdRef.current = null;
        }
      },
      onTargetsSnapshot: (nextActiveTargetId, nextTargets) => {
        setTargets((current) => mergeTargetsInCurrentOrder(current, nextTargets));
        const resolvedActive =
          nextActiveTargetId ??
          nextTargets.find((target) => target.id === activeTargetIdRef.current)?.id ??
          nextTargets[0]?.id ??
          null;
        setActiveTargetId(resolvedActive);
        if (
          resolvedActive &&
          connection.isOpen() &&
          screencastTargetIdRef.current !== resolvedActive
        ) {
          connection.send({
            type: "viewport.set",
            targetId: resolvedActive,
            width: viewportRef.current.width,
            height: viewportRef.current.height,
            deviceScaleFactor: 1,
          });
          if (!shouldWaitForWebRTC()) {
            connection.send({
              type: "screencast.start",
              targetId: resolvedActive,
              format: "jpeg",
              quality: 80,
              maxWidth: viewportRef.current.width,
              maxHeight: viewportRef.current.height,
            });
            screencastTargetIdRef.current = resolvedActive;
          }
        }
      },
      onTargetChanged: (change, target) => {
        if (change === "destroyed" && screencastTargetIdRef.current === target.id) {
          screencastTargetIdRef.current = null;
        }
        setTargets((current) => {
          if (change === "destroyed") {
            return current.filter((item) => item.id !== target.id);
          }
          const index = current.findIndex((item) => item.id === target.id);
          if (index === -1) {
            return [...current, target];
          }
          const next = [...current];
          next[index] = target;
          return next;
        });
      },
      onScreencastFrame: (nextFrame) => {
        setFrame(nextFrame);
        setFrameStale(false);
      },
      onScreencastStopped: () => {
        setFrame(null);
        screencastTargetIdRef.current = null;
      },
      onError: (error) => {
        setLastError(error);
        if (error.code !== "not_implemented" && !isDisconnectedSocketError(error.message)) {
          toast.error(error.message);
        }
      },
    });

    connectionRef.current = connection;
    connection.connect(sessionId, credentials);

    return () => {
      connection.close();
      if (connectionRef.current === connection) {
        connectionRef.current = null;
      }
    };
  }, [enabled, sessionId, credentials, shouldWaitForWebRTC]);

  useEffect(() => {
    if (webrtcMedia.phase !== "live" || !webrtcMedia.stream || !screencastTargetIdRef.current) {
      return;
    }
    send({ type: "screencast.stop" });
    screencastTargetIdRef.current = null;
    setFrame(null);
  }, [webrtcMedia.phase, webrtcMedia.stream, send]);

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

  useEffect(() => {
    if (phase !== "connected" || frame || !activeTargetId || shouldWaitForWebRTC()) {
      return;
    }

    const timer = window.setTimeout(
      () => {
        startScreencast();
      },
      webrtcMedia.phase === "failed" ? 0 : 2500,
    );

    return () => window.clearTimeout(timer);
  }, [
    phase,
    frame,
    activeTargetId,
    startScreencast,
    shouldWaitForWebRTC,
    webrtcMedia.phase,
    webrtcMedia.stream,
  ]);

  return {
    phase,
    targets,
    activeTargetId,
    activeTarget,
    frame,
    frameStale,
    mediaPhase: webrtcMedia.phase,
    mediaStream: webrtcMedia.stream,
    mediaSize: webrtcMedia.size,
    mediaError: webrtcMedia.error,
    lastError,
    viewport,
    browserViewportSize,
    viewportAutoSync,
    captured,
    setCaptured,
    setViewport: applyViewport,
    setBrowserViewportSize,
    setViewportAutoSync,
    setViewportToBrowserSize,
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
    reconnect,
  };
}

function isDisconnectedSocketError(message: string): boolean {
  return /^CDP (browser )?socket (is not open|closed|failed)$/.test(message);
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

function createBrowserViewport(size: BrowserViewportSize): ViewportPreset {
  return {
    id: `browser-${size.width}x${size.height}`,
    label: `${size.width}×${size.height}`,
    width: size.width,
    height: size.height,
  };
}
