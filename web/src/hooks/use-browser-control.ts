import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { BrowserControlConnection } from "#/lib/control/connection.ts";
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

export type UseBrowserControlResult = {
  phase: ControlConnectionPhase;
  targets: ControlTarget[];
  activeTargetId: string | null;
  activeTarget: ControlTarget | null;
  frame: ScreencastFrame | null;
  frameStale: boolean;
  lastError: ControlError | null;
  viewport: ViewportPreset;
  captured: boolean;
  setCaptured: (captured: boolean) => void;
  setViewport: (viewport: ViewportPreset) => void;
  send: (message: ClientMessage) => boolean;
  activateTarget: (targetId: string) => void;
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
  const [captured, setCaptured] = useState(false);

  const connectionRef = useRef<BrowserControlConnection | null>(null);
  const activeTargetIdRef = useRef<string | null>(null);
  const viewportRef = useRef(viewport);

  activeTargetIdRef.current = activeTargetId;
  viewportRef.current = viewport;

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
    send({
      type: "screencast.start",
      targetId,
      format: "jpeg",
      quality: 80,
      maxWidth: viewportRef.current.width,
      maxHeight: viewportRef.current.height,
    });
  }, [send]);

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
        }
      },
      onTargetsSnapshot: (nextActiveTargetId, nextTargets) => {
        setTargets(nextTargets);
        const resolvedActive =
          nextActiveTargetId ??
          nextTargets.find((target) => target.id === activeTargetIdRef.current)?.id ??
          nextTargets[0]?.id ??
          null;
        setActiveTargetId(resolvedActive);
        if (resolvedActive && connection.isOpen()) {
          connection.send({
            type: "screencast.start",
            targetId: resolvedActive,
            format: "jpeg",
            quality: 80,
            maxWidth: viewportRef.current.width,
            maxHeight: viewportRef.current.height,
          });
        }
      },
      onTargetChanged: (change, target) => {
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
      },
      onError: (error) => {
        setLastError(error);
        if (error.code !== "not_implemented") {
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
  }, [enabled, sessionId, credentials]);

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
    phase,
    targets,
    activeTargetId,
    activeTarget,
    frame,
    frameStale,
    lastError,
    viewport,
    captured,
    setCaptured,
    setViewport: applyViewport,
    send,
    activateTarget,
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
