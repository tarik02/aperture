import { useEffect, useRef, useState } from "react";
import { Activity, AlertCircle, Loader2, MousePointer2, Unplug } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "#/components/ui/badge.tsx";
import {
  keyboardInputMessage,
  keyboardModifiers,
  shouldForwardBrowserShortcut,
} from "#/lib/control/keyboard.ts";
import { computeRenderMetrics } from "#/lib/control/viewport.ts";
import type {
  ControlConnectionPhase,
  ControlError,
  ScreencastFrame,
} from "#/lib/control/messages.ts";
import type { ViewportPreset } from "#/lib/control/viewport.ts";
import type { UseBrowserControlResult } from "#/hooks/use-browser-control.ts";

type BrowserViewportProps = {
  control: UseBrowserControlResult;
  viewport: ViewportPreset;
  performanceOverlayEnabled: boolean;
};

type MouseButton = "left" | "middle" | "right" | "none";
type ViewportPoint = { x: number; y: number };

const MULTI_CLICK_MS = 500;
const MULTI_CLICK_DISTANCE = 5;

export function BrowserViewport({
  control,
  viewport,
  performanceOverlayEnabled,
}: BrowserViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pointerCaptureRef = useRef<{
    pointerId: number;
    targetId: string;
    button: MouseButton;
    clickCount: number;
  } | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const lastClickRef = useRef<{
    targetId: string;
    button: MouseButton;
    point: ViewportPoint;
    time: number;
    clickCount: number;
  } | null>(null);
  const [cursorHintPoint, setCursorHintPoint] = useState<ViewportPoint | null>(null);

  const showingWebRTC = control.mediaPhase === "live" && Boolean(control.mediaStream);
  const renderWidth = showingWebRTC
    ? (control.mediaSize?.width ?? viewport.width)
    : (control.frame?.width ?? viewport.width);
  const renderHeight = showingWebRTC
    ? (control.mediaSize?.height ?? viewport.height)
    : (control.frame?.height ?? viewport.height);
  const inputWidth = showingWebRTC ? renderWidth : viewport.width;
  const inputHeight = showingWebRTC ? renderHeight : viewport.height;
  const displayMetrics = computeRenderMetrics(
    control.browserViewportSize?.width ?? renderWidth,
    control.browserViewportSize?.height ?? renderHeight,
    renderWidth,
    renderHeight,
  );
  const disconnectedHint = resolveDisconnectedHint(control.phase, control.lastError);

  useEffect(() => {
    if (!control.frame || !imageRef.current) {
      return;
    }
    const mime = control.frame.format === "png" ? "image/png" : "image/jpeg";
    imageRef.current.src = `data:${mime};base64,${control.frame.data}`;
  }, [control.frame]);

  useEffect(() => {
    if (!videoRef.current) {
      return;
    }
    videoRef.current.srcObject = showingWebRTC ? control.mediaStream : null;
  }, [control.mediaStream, showingWebRTC]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    const syncSize = (width: number, height: number) => {
      control.setBrowserViewportSize({ width, height });
    };

    const rect = element.getBoundingClientRect();
    syncSize(rect.width, rect.height);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        syncSize(entry.contentRect.width, entry.contentRect.height);
      }
    });
    observer.observe(element);

    return () => observer.disconnect();
  }, [control.setBrowserViewportSize]);

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
    };
  }, []);

  function mapPointer(event: { clientX: number; clientY: number }, clamp: boolean) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) {
      return null;
    }
    const metrics = computeRenderMetrics(rect.width, rect.height, renderWidth, renderHeight);
    const localX = event.clientX - rect.left - metrics.offsetX;
    const localY = event.clientY - rect.top - metrics.offsetY;
    if (
      !clamp &&
      (localX < 0 ||
        localY < 0 ||
        localX > metrics.renderedWidth ||
        localY > metrics.renderedHeight)
    ) {
      return null;
    }
    const x = (localX / metrics.scale) * (inputWidth / renderWidth);
    const y = (localY / metrics.scale) * (inputHeight / renderHeight);
    if (clamp) {
      return {
        x: Math.round(clampNumber(x, 0, Math.max(inputWidth - 1, 0))),
        y: Math.round(clampNumber(y, 0, Math.max(inputHeight - 1, 0))),
      };
    }
    return { x: Math.round(x), y: Math.round(y) };
  }

  function resolveInputTarget() {
    if (control.phase !== "connected" || !control.activeTargetId) {
      return null;
    }
    if (!control.captured) {
      control.setCaptured(true);
    }
    containerRef.current?.focus();
    return control.activeTargetId;
  }

  function preventViewportDefault(event: React.SyntheticEvent) {
    event.preventDefault();
    event.stopPropagation();
  }

  function preventNativeDefault(event: PointerEvent) {
    if (event.cancelable) {
      event.preventDefault();
    }
    event.stopPropagation();
  }

  function handleCaptureClick() {
    if (control.phase !== "connected") {
      return;
    }
    control.setCaptured(true);
    containerRef.current?.focus();
  }

  function handlePointerClick() {
    if (!control.captured) {
      handleCaptureClick();
    }
  }

  function handlePointerMove(event: React.PointerEvent) {
    updateCursorHint(event);

    const capturedPointer = pointerCaptureRef.current;
    if (capturedPointer?.pointerId === event.pointerId) {
      return;
    }
    const targetId = control.captured && event.buttons === 0 ? control.activeTargetId : null;
    if (!targetId) {
      return;
    }
    const point = mapPointer(event, false);
    if (!point) {
      return;
    }
    preventViewportDefault(event);
    control.send({
      type: "input.mouse",
      targetId,
      action: "move",
      x: point.x,
      y: point.y,
      button: "none",
      buttons: 0,
      clickCount: 0,
      modifiers: keyboardModifiers(event.nativeEvent),
    });
  }

  function handlePointerDown(event: React.PointerEvent) {
    updateCursorHint(event);

    const targetId = resolveInputTarget();
    if (!targetId) {
      return;
    }
    const point = mapPointer(event, false);
    if (!point) {
      return;
    }
    const element = containerRef.current;
    if (!element) {
      return;
    }
    const button = resolveMouseButton(event.button);
    const now = Date.now();
    const clickCount = resolveClickCount(targetId, button, point, now, lastClickRef.current);
    lastClickRef.current = {
      targetId,
      button,
      point,
      time: now,
      clickCount,
    };
    preventViewportDefault(event);
    pointerCaptureRef.current = { pointerId: event.pointerId, targetId, button, clickCount };
    dragCleanupRef.current?.();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer events and some browser edge cases do not create a capturable pointer.
    }
    bindDragListeners({
      pointerId: event.pointerId,
      targetId,
      button,
      clickCount,
      element,
    });
    control.send({
      type: "input.mouse",
      targetId,
      action: "down",
      x: point.x,
      y: point.y,
      button,
      buttons: event.buttons,
      clickCount,
      modifiers: keyboardModifiers(event.nativeEvent),
    });
  }

  function handlePointerUp(event: React.PointerEvent) {
    const capturedPointer = pointerCaptureRef.current;
    const targetId =
      capturedPointer?.pointerId === event.pointerId
        ? capturedPointer.targetId
        : control.activeTargetId;
    if (!targetId) {
      return;
    }
    const point = mapPointer(event, capturedPointer?.pointerId === event.pointerId);
    if (!point) {
      return;
    }
    preventViewportDefault(event);
    control.send({
      type: "input.mouse",
      targetId,
      action: "up",
      x: point.x,
      y: point.y,
      button: capturedPointer?.button ?? resolveMouseButton(event.button),
      buttons: event.buttons,
      clickCount: capturedPointer?.clickCount ?? 1,
      modifiers: keyboardModifiers(event.nativeEvent),
    });
    if (capturedPointer?.pointerId === event.pointerId) {
      pointerCaptureRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }

  function handlePointerCancel(event: React.PointerEvent) {
    const capturedPointer = pointerCaptureRef.current;
    if (capturedPointer?.pointerId !== event.pointerId) {
      return;
    }
    const point = mapPointer(event, true);
    pointerCaptureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!point) {
      return;
    }
    preventViewportDefault(event);
    control.send({
      type: "input.mouse",
      targetId: capturedPointer.targetId,
      action: "up",
      x: point.x,
      y: point.y,
      button: capturedPointer.button,
      buttons: 0,
      clickCount: capturedPointer.clickCount,
      modifiers: keyboardModifiers(event.nativeEvent),
    });
  }

  function bindDragListeners({
    pointerId,
    targetId,
    button,
    clickCount,
    element,
  }: {
    pointerId: number;
    targetId: string;
    button: MouseButton;
    clickCount: number;
    element: HTMLDivElement;
  }) {
    const handleMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) {
        return;
      }
      const point = mapPointer(event, true);
      preventNativeDefault(event);
      if (!point) {
        return;
      }
      control.send({
        type: "input.mouse",
        targetId,
        action: "move",
        x: point.x,
        y: point.y,
        button,
        buttons: event.buttons || mouseButtonsForButton(button),
        clickCount,
        modifiers: keyboardModifiers(event),
      });
    };

    const finish = (event: PointerEvent, canceled: boolean) => {
      if (event.pointerId !== pointerId) {
        return;
      }
      const point = mapPointer(event, true);
      preventNativeDefault(event);
      if (point) {
        control.send({
          type: "input.mouse",
          targetId,
          action: "up",
          x: point.x,
          y: point.y,
          button,
          buttons: 0,
          clickCount,
          modifiers: keyboardModifiers(event),
        });
        if (!canceled) {
          lastClickRef.current = {
            targetId,
            button,
            point,
            time: Date.now(),
            clickCount,
          };
        }
      }
      cleanup();
    };

    const handleUp = (event: PointerEvent) => finish(event, false);
    const handleCancel = (event: PointerEvent) => finish(event, true);
    const cleanup = () => {
      window.removeEventListener("pointermove", handleMove, true);
      window.removeEventListener("pointerup", handleUp, true);
      window.removeEventListener("pointercancel", handleCancel, true);
      try {
        if (element.hasPointerCapture(pointerId)) {
          element.releasePointerCapture(pointerId);
        }
      } catch {
        // Synthetic pointer events and released native pointers may not have active capture.
      }
      if (pointerCaptureRef.current?.pointerId === pointerId) {
        pointerCaptureRef.current = null;
      }
      if (dragCleanupRef.current === cleanup) {
        dragCleanupRef.current = null;
      }
    };

    dragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", handleMove, true);
    window.addEventListener("pointerup", handleUp, true);
    window.addEventListener("pointercancel", handleCancel, true);
  }

  function handleWheel(event: React.WheelEvent) {
    const targetId = resolveInputTarget();
    if (!targetId) {
      return;
    }
    const point = mapPointer(event, false);
    if (!point) {
      return;
    }
    preventViewportDefault(event);
    const wheelScale = wheelDeltaScale(event.deltaMode, inputHeight);
    control.send({
      type: "input.wheel",
      targetId,
      x: point.x,
      y: point.y,
      deltaX: event.deltaX * wheelScale,
      deltaY: event.deltaY * wheelScale,
      modifiers: keyboardModifiers(event.nativeEvent),
    });
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    const targetId = control.activeTargetId;
    if (
      !targetId ||
      (!control.captured &&
        document.activeElement !== containerRef.current &&
        !containerRef.current?.contains(event.target as Node))
    ) {
      return;
    }
    if (event.key === "Escape") {
      if (control.captured) {
        event.preventDefault();
        event.stopPropagation();
        control.setCaptured(false);
      }
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const clipboardShortcut = resolveClipboardShortcut(event.nativeEvent);
    if (clipboardShortcut === "copy") {
      control.send({ type: "clipboard.copy", targetId });
      return;
    }
    if (clipboardShortcut === "cut") {
      control.send({ type: "clipboard.cut", targetId });
      return;
    }
    if (clipboardShortcut === "paste") {
      void pasteClipboard(control);
      return;
    }

    if (!shouldForwardBrowserShortcut(event.nativeEvent)) {
      return;
    }

    control.send({
      type: "input.key",
      targetId,
      action: "down",
      ...keyboardInputMessage(event.nativeEvent, "down"),
    });
  }

  function handleKeyUp(event: React.KeyboardEvent) {
    const targetId = control.activeTargetId;
    if (
      !targetId ||
      (!control.captured &&
        document.activeElement !== containerRef.current &&
        !containerRef.current?.contains(event.target as Node))
    ) {
      return;
    }
    if (event.key === "Escape") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (resolveClipboardShortcut(event.nativeEvent)) {
      return;
    }

    if (!shouldForwardBrowserShortcut(event.nativeEvent)) {
      return;
    }

    control.send({
      type: "input.key",
      targetId,
      action: "up",
      ...keyboardInputMessage(event.nativeEvent, "up"),
    });
  }

  function updateCursorHint(event: React.PointerEvent) {
    if (!disconnectedHint) {
      return;
    }
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    setCursorHintPoint({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  }

  const status = resolveViewportStatus(
    control.phase,
    control.frame,
    control.frameStale,
    control.mediaPhase,
    control.mediaPath,
    showingWebRTC,
  );
  const visibleLastError =
    control.lastError &&
    control.phase === "connected" &&
    !isDisconnectedSocketError(control.lastError.message)
      ? control.lastError
      : null;

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onClick={handlePointerClick}
      onPointerMove={handlePointerMove}
      onPointerEnter={updateCursorHint}
      onPointerLeave={() => setCursorHintPoint(null)}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onWheel={handleWheel}
      onContextMenu={(event) => {
        if (control.captured) {
          event.preventDefault();
        }
      }}
      className="relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden bg-background outline-none"
    >
      {showingWebRTC ? (
        <div
          className="relative overflow-hidden bg-black"
          style={{
            width: displayMetrics.renderedWidth,
            height: displayMetrics.renderedHeight,
          }}
        >
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            data-viewport-width={renderWidth}
            data-viewport-height={renderHeight}
            className="absolute inset-0 h-full w-full object-cover"
          />
        </div>
      ) : control.frame ? (
        <div
          className="relative overflow-hidden bg-black"
          style={{
            width: displayMetrics.renderedWidth,
            height: displayMetrics.renderedHeight,
          }}
        >
          <img
            ref={imageRef}
            alt=""
            draggable={false}
            className="absolute inset-0 h-full w-full object-contain"
          />
        </div>
      ) : (
        <ViewportPlaceholder phase={control.phase} mediaPhase={control.mediaPhase} />
      )}
      <div className="pointer-events-none absolute top-2 right-2 flex items-center gap-1.5">
        {control.captured ? (
          <Badge variant="default" className="gap-1">
            <MousePointer2 />
            captured
          </Badge>
        ) : null}
        <StatusBadge status={status} />
      </div>
      {performanceOverlayEnabled && showingWebRTC ? <PerformanceOverlay control={control} /> : null}
      {disconnectedHint && cursorHintPoint ? (
        <div
          className="pointer-events-none absolute z-20 max-w-64 translate-x-3 translate-y-3 rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
          style={{ left: cursorHintPoint.x, top: cursorHintPoint.y }}
        >
          {disconnectedHint}
        </div>
      ) : null}
      {visibleLastError ? (
        <div className="pointer-events-none absolute bottom-2 left-2 max-w-[80%] rounded-md border border-destructive/40 bg-background/90 px-2 py-1 text-xs text-destructive">
          {visibleLastError.message}
        </div>
      ) : null}
      {control.mediaError ? (
        <div className="pointer-events-none absolute right-2 bottom-2 max-w-[80%] rounded-md border border-amber-500/40 bg-background/90 px-2 py-1 text-xs text-amber-800 dark:text-amber-300">
          {control.mediaError}
        </div>
      ) : null}
    </div>
  );
}

function PerformanceOverlay({ control }: { control: UseBrowserControlResult }) {
  const metrics = control.mediaMetrics;
  const settings = control.mediaStreamSettings;
  const rows = [
    ["Target", settings ? `${settings.fps} fps / ${settings.bitrateKbps} kbps` : "n/a"],
    ["Recv", formatKbps(metrics?.receivedBitrateKbps)],
    ["FPS", formatNumber(metrics?.decodedFps, 1)],
    ["Frame", formatFrameSize(metrics?.frameWidth, metrics?.frameHeight)],
    ["Drop", formatNumber(metrics?.framesDropped, 0)],
    ["Lost", formatNumber(metrics?.packetsLost, 0)],
    ["Jitter", formatMs(metrics?.jitterMs)],
    ["Buffer", formatMs(metrics?.jitterBufferDelayMs)],
    ["RTT", formatMs(metrics?.roundTripTimeMs)],
    ["Input", formatMs(metrics?.inputRttMs)],
    ["Codec", metrics?.codec?.replace(/^video\//, "") ?? "n/a"],
    ["Path", metrics?.candidatePair ?? "n/a"],
  ];

  return (
    <div className="pointer-events-none absolute top-2 left-2 z-10 w-64 rounded-md border bg-background/90 p-2 text-xs shadow-md backdrop-blur">
      <div className="mb-1.5 flex items-center gap-1.5 font-medium">
        <Activity className="size-3.5" />
        Performance
      </div>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <span className="text-muted-foreground">{label}</span>
            <span className="min-w-0 truncate text-right font-mono tabular-nums">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function resolveDisconnectedHint(
  phase: ControlConnectionPhase,
  lastError: ControlError | null,
): string | null {
  if (lastError && isDisconnectedSocketError(lastError.message)) {
    return "CDP disconnected";
  }
  if (phase === "disconnected" || phase === "error") {
    return "CDP disconnected";
  }
  return null;
}

function formatKbps(value: number | null | undefined) {
  if (typeof value !== "number") {
    return "n/a";
  }
  return value >= 1000 ? `${(value / 1000).toFixed(1)} Mbps` : `${Math.round(value)} kbps`;
}

function formatNumber(value: number | null | undefined, fractionDigits: number) {
  return typeof value === "number" ? value.toFixed(fractionDigits) : "n/a";
}

function formatMs(value: number | null | undefined) {
  return typeof value === "number" ? `${Math.round(value)} ms` : "n/a";
}

function formatFrameSize(width: number | null | undefined, height: number | null | undefined) {
  return typeof width === "number" && typeof height === "number"
    ? `${Math.round(width)}x${Math.round(height)}`
    : "n/a";
}

function isDisconnectedSocketError(message: string): boolean {
  return /^CDP (browser )?socket (is not open|closed|failed)$/.test(message);
}

function ViewportPlaceholder({
  phase,
  mediaPhase,
}: {
  phase: ControlConnectionPhase;
  mediaPhase: UseBrowserControlResult["mediaPhase"];
}) {
  if (phase === "connecting") {
    return (
      <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
        Connecting
      </div>
    );
  }
  if (phase === "connected" && mediaPhase === "connecting") {
    return (
      <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
        Connecting media
      </div>
    );
  }
  if (phase === "disconnected" || phase === "error") {
    return (
      <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
        <Unplug className="size-5" />
        Disconnected
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-5 animate-spin" />
      Waiting for frame
    </div>
  );
}

function StatusBadge({
  status,
}: {
  status: "live" | "webrtc-live" | "fallback-cdp" | "stale" | "offline";
}) {
  if (status === "live" || status === "webrtc-live" || status === "fallback-cdp") {
    return (
      <Badge
        variant="secondary"
        className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      >
        {status}
      </Badge>
    );
  }
  if (status === "stale") {
    return (
      <Badge
        variant="secondary"
        className="gap-1 bg-amber-500/15 text-amber-800 dark:text-amber-300"
      >
        <AlertCircle />
        stale
      </Badge>
    );
  }
  return <Badge variant="outline">offline</Badge>;
}

function resolveClipboardShortcut(event: KeyboardEvent): "copy" | "cut" | "paste" | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) {
    return null;
  }

  switch (event.key.toLowerCase()) {
    case "c":
      return "copy";
    case "x":
      return "cut";
    case "v":
      return "paste";
    default:
      return null;
  }
}

function resolveMouseButton(button: number): MouseButton {
  if (button === 0) {
    return "left";
  }
  if (button === 1) {
    return "middle";
  }
  if (button === 2) {
    return "right";
  }
  return "none";
}

function resolveClickCount(
  targetId: string,
  button: MouseButton,
  point: ViewportPoint,
  time: number,
  previous: {
    targetId: string;
    button: MouseButton;
    point: ViewportPoint;
    time: number;
    clickCount: number;
  } | null,
): number {
  if (
    previous &&
    previous.targetId === targetId &&
    previous.button === button &&
    time - previous.time <= MULTI_CLICK_MS &&
    Math.abs(previous.point.x - point.x) <= MULTI_CLICK_DISTANCE &&
    Math.abs(previous.point.y - point.y) <= MULTI_CLICK_DISTANCE
  ) {
    return Math.min(previous.clickCount + 1, 3);
  }
  return 1;
}

function mouseButtonsForButton(button: MouseButton): number {
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

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function wheelDeltaScale(deltaMode: number, viewportHeight: number): number {
  if (deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return 16;
  }
  if (deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return viewportHeight;
  }
  return 1;
}

async function pasteClipboard(control: UseBrowserControlResult) {
  if (!control.activeTargetId) {
    return;
  }

  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch (error) {
    console.warn("Clipboard read failed", error);
    toast.error("Clipboard read failed");
    return;
  }

  if (!text) {
    return;
  }

  control.send({
    type: "clipboard.paste",
    targetId: control.activeTargetId,
    items: [{ mimeType: "text/plain", data: text }],
  });
}

function resolveViewportStatus(
  phase: ControlConnectionPhase,
  frame: ScreencastFrame | null,
  frameStale: boolean,
  mediaPhase: UseBrowserControlResult["mediaPhase"],
  mediaPath: UseBrowserControlResult["mediaPath"],
  showingWebRTC: boolean,
): "live" | "webrtc-live" | "fallback-cdp" | "stale" | "offline" {
  if (phase !== "connected") {
    return "offline";
  }
  if (mediaPhase === "live" && showingWebRTC) {
    return "webrtc-live";
  }
  if (!frame) {
    return "offline";
  }
  if (frameStale) {
    return "stale";
  }
  return mediaPath === "fallback-cdp" ? "fallback-cdp" : "live";
}
