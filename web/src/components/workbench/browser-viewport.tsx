import { useEffect, useRef } from "react";
import { AlertCircle, Loader2, MousePointer2, Unplug } from "lucide-react";
import { Badge } from "#/components/ui/badge.tsx";
import {
  isPrintableKey,
  keyboardModifiers,
  shouldForwardBrowserShortcut,
} from "#/lib/control/keyboard.ts";
import { mapClientToViewport } from "#/lib/control/viewport.ts";
import type { ControlConnectionPhase, ScreencastFrame } from "#/lib/control/messages.ts";
import type { ViewportPreset } from "#/lib/control/viewport.ts";
import type { UseBrowserControlResult } from "#/hooks/use-browser-control.ts";
import { cn } from "#/lib/utils.ts";

type BrowserViewportProps = {
  control: UseBrowserControlResult;
  viewport: ViewportPreset;
};

export function BrowserViewport({ control, viewport }: BrowserViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  const emulatedWidth = control.frame?.width ?? viewport.width;
  const emulatedHeight = control.frame?.height ?? viewport.height;

  useEffect(() => {
    if (!control.frame || !imageRef.current) {
      return;
    }
    const mime = control.frame.format === "png" ? "image/png" : "image/jpeg";
    imageRef.current.src = `data:${mime};base64,${control.frame.data}`;
  }, [control.frame]);

  function mapPointer(event: { clientX: number; clientY: number }) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) {
      return null;
    }
    return mapClientToViewport(event.clientX, event.clientY, rect, emulatedWidth, emulatedHeight);
  }

  function withTarget(
    event: React.MouseEvent | React.WheelEvent,
    handler: (targetId: string, point: { x: number; y: number }) => void,
  ) {
    if (!control.captured || !control.activeTargetId) {
      return;
    }
    const point = mapPointer(event);
    if (!point) {
      return;
    }
    event.preventDefault();
    handler(control.activeTargetId, point);
  }

  function handleCaptureClick() {
    if (control.phase !== "connected") {
      return;
    }
    control.setCaptured(true);
    containerRef.current?.focus();
  }

  function handlePointerClick(event: React.MouseEvent) {
    if (!control.captured) {
      handleCaptureClick();
      return;
    }
    handleClick(event);
  }

  function handleMouseMove(event: React.MouseEvent) {
    withTarget(event, (targetId, point) => {
      control.send({
        type: "input.mouse",
        targetId,
        action: "move",
        x: point.x,
        y: point.y,
        modifiers: keyboardModifiers(event.nativeEvent),
      });
    });
  }

  function handleMouseDown(event: React.MouseEvent) {
    withTarget(event, (targetId, point) => {
      const button =
        event.button === 2
          ? "right"
          : event.button === 1
            ? "middle"
            : event.button === 0
              ? "left"
              : "none";
      control.send({
        type: "input.mouse",
        targetId,
        action: "down",
        x: point.x,
        y: point.y,
        button,
        modifiers: keyboardModifiers(event.nativeEvent),
      });
    });
  }

  function handleMouseUp(event: React.MouseEvent) {
    withTarget(event, (targetId, point) => {
      const button =
        event.button === 2
          ? "right"
          : event.button === 1
            ? "middle"
            : event.button === 0
              ? "left"
              : "none";
      control.send({
        type: "input.mouse",
        targetId,
        action: "up",
        x: point.x,
        y: point.y,
        button,
        modifiers: keyboardModifiers(event.nativeEvent),
      });
    });
  }

  function handleClick(event: React.MouseEvent) {
    withTarget(event, (targetId, point) => {
      control.send({
        type: "input.mouse",
        targetId,
        action: "click",
        x: point.x,
        y: point.y,
        clickCount: event.detail,
        modifiers: keyboardModifiers(event.nativeEvent),
      });
    });
  }

  function handleWheel(event: React.WheelEvent) {
    withTarget(event, (targetId, point) => {
      control.send({
        type: "input.wheel",
        targetId,
        x: point.x,
        y: point.y,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        modifiers: keyboardModifiers(event.nativeEvent),
      });
    });
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (!control.captured || !control.activeTargetId) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      control.setCaptured(false);
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (!shouldForwardBrowserShortcut(event.nativeEvent)) {
      return;
    }

    const targetId = control.activeTargetId;
    const modifiers = keyboardModifiers(event.nativeEvent);
    if (!isPrintableKey(event.nativeEvent)) {
      control.send({
        type: "input.key",
        targetId,
        action: "down",
        key: event.key,
        code: event.code,
        modifiers,
      });
    }
  }

  function handleKeyUp(event: React.KeyboardEvent) {
    if (!control.captured || !control.activeTargetId) {
      return;
    }
    if (event.key === "Escape") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (!shouldForwardBrowserShortcut(event.nativeEvent)) {
      return;
    }

    const targetId = control.activeTargetId;
    const modifiers = keyboardModifiers(event.nativeEvent);
    if (isPrintableKey(event.nativeEvent)) {
      control.send({
        type: "input.key",
        targetId,
        action: "char",
        text: event.key,
        modifiers,
      });
      return;
    }
    control.send({
      type: "input.key",
      targetId,
      action: "down",
      key: event.key,
      code: event.code,
      modifiers,
    });
    control.send({
      type: "input.key",
      targetId,
      action: "up",
      key: event.key,
      code: event.code,
      modifiers,
    });
  }

  const status = resolveViewportStatus(control.phase, control.frame, control.frameStale);

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onClick={handlePointerClick}
      onMouseMove={handleMouseMove}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onWheel={handleWheel}
      onContextMenu={(event) => {
        if (control.captured) {
          event.preventDefault();
        }
      }}
      className={cn(
        "relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-md border bg-muted/30 outline-none",
        control.captured && "ring-2 ring-primary",
      )}
    >
      {control.frame ? (
        <img
          ref={imageRef}
          alt=""
          draggable={false}
          className="max-h-full max-w-full object-contain"
          style={{ aspectRatio: `${emulatedWidth} / ${emulatedHeight}` }}
        />
      ) : (
        <ViewportPlaceholder phase={control.phase} />
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
      {control.lastError && control.phase === "connected" ? (
        <div className="pointer-events-none absolute bottom-2 left-2 max-w-[80%] rounded-md border border-destructive/40 bg-background/90 px-2 py-1 text-xs text-destructive">
          {control.lastError.message}
        </div>
      ) : null}
    </div>
  );
}

function ViewportPlaceholder({ phase }: { phase: ControlConnectionPhase }) {
  if (phase === "connecting") {
    return (
      <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
        Connecting
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

function StatusBadge({ status }: { status: "live" | "stale" | "offline" }) {
  if (status === "live") {
    return (
      <Badge
        variant="secondary"
        className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      >
        live
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

function resolveViewportStatus(
  phase: ControlConnectionPhase,
  frame: ScreencastFrame | null,
  frameStale: boolean,
): "live" | "stale" | "offline" {
  if (phase !== "connected") {
    return "offline";
  }
  if (!frame) {
    return "offline";
  }
  return frameStale ? "stale" : "live";
}
