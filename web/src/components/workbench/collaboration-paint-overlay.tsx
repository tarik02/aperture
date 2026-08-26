import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import type {
  CollaborationControl,
  CollaborationPaintPoint,
} from "#/hooks/use-collaboration-control.ts";
import { collaborationPaintLifetimeMs } from "#/hooks/use-collaboration-control.ts";
import { cn } from "#/lib/utils.ts";

type CollaborationPaintOverlayProps = {
  collaboration: CollaborationControl;
  targetId: string;
  enabled: boolean;
  visible: boolean;
  left: number;
  top: number;
  width: number;
  height: number;
};

const paintColors = ["#f43f5e", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#8b5cf6"];
const paintWidth = 4;
const paintSendIntervalMs = 24;
const maximumPaintPoints = 2_048;
const maximumPaintStrokes = 512;

type PaintStroke = {
  targetId: string;
  color: string;
  width: number;
  points: ReadonlyArray<{ x: number; y: number }>;
  updatedAt: number;
  ended: boolean;
};

export function CollaborationPaintOverlay({
  collaboration,
  targetId,
  enabled,
  visible,
  left,
  top,
  width,
  height,
}: CollaborationPaintOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeStrokeIdRef = useRef<string | null>(null);
  const lastPointSentAtRef = useRef(0);
  const strokesRef = useRef(new Map<string, PaintStroke>());
  const color = colorForClient(collaboration.clientId);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const pixelRatio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(width * pixelRatio));
    canvas.height = Math.max(1, Math.round(height * pixelRatio));

    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    let animationFrame: number | null = null;
    const draw = () => {
      animationFrame = null;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, width, height);
      const now = Date.now();
      let visibleStrokeCount = 0;

      for (const [key, stroke] of strokesRef.current) {
        const age = now - stroke.updatedAt;
        if (age >= collaborationPaintLifetimeMs) {
          strokesRef.current.delete(key);
          continue;
        }
        visibleStrokeCount += 1;
        if (stroke.targetId !== targetId || stroke.points.length === 0) {
          continue;
        }
        const opacity = 1 - age / collaborationPaintLifetimeMs;
        context.globalAlpha = opacity;
        context.strokeStyle = stroke.color;
        context.fillStyle = stroke.color;
        context.lineWidth = stroke.width;
        context.lineCap = "round";
        context.lineJoin = "round";

        const first = stroke.points[0];
        if (!first) {
          continue;
        }
        if (stroke.points.length === 1) {
          context.beginPath();
          context.arc(first.x * width, first.y * height, stroke.width / 2, 0, Math.PI * 2);
          context.fill();
          continue;
        }
        context.beginPath();
        context.moveTo(first.x * width, first.y * height);
        for (let index = 1; index < stroke.points.length - 1; index += 1) {
          const point = stroke.points[index];
          const next = stroke.points[index + 1];
          if (!point || !next) {
            continue;
          }
          context.quadraticCurveTo(
            point.x * width,
            point.y * height,
            ((point.x + next.x) / 2) * width,
            ((point.y + next.y) / 2) * height,
          );
        }
        const last = stroke.points[stroke.points.length - 1];
        if (last) {
          context.lineTo(last.x * width, last.y * height);
        }
        context.stroke();
      }
      context.globalAlpha = 1;
      if (visibleStrokeCount > 0) {
        animationFrame = window.requestAnimationFrame(draw);
      }
    };

    const requestDraw = () => {
      if (animationFrame === null) {
        animationFrame = window.requestAnimationFrame(draw);
      }
    };

    const subscription = collaboration.paintEvents.subscribe((event) => {
      if (event.type === "clear") {
        strokesRef.current.clear();
        requestDraw();
        return;
      }
      const message = event.message;
      const key = `${message.clientId}:${message.targetId}:${message.strokeId}`;
      const existing = strokesRef.current.get(key);
      if (
        (message.phase !== "start" && !existing) ||
        (existing?.ended && message.phase !== "start")
      ) {
        return;
      }
      let points =
        message.phase === "start" || !existing
          ? [{ x: message.x, y: message.y }]
          : [...existing.points, { x: message.x, y: message.y }];
      if (points.length > maximumPaintPoints) {
        points = points.filter((_, index) => index % 2 === 0);
      }
      if (!existing && strokesRef.current.size >= maximumPaintStrokes) {
        let oldestKey: string | null = null;
        let oldestUpdatedAt = Number.POSITIVE_INFINITY;
        for (const [candidateKey, stroke] of strokesRef.current) {
          if (stroke.updatedAt < oldestUpdatedAt) {
            oldestKey = candidateKey;
            oldestUpdatedAt = stroke.updatedAt;
          }
        }
        if (oldestKey) {
          strokesRef.current.delete(oldestKey);
        }
      }
      strokesRef.current.set(key, {
        targetId: message.targetId,
        color: message.color,
        width: message.width,
        points,
        updatedAt: Date.now(),
        ended: message.phase === "end",
      });
      requestDraw();
    });

    draw();
    return () => {
      subscription.unsubscribe();
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
    };
  }, [collaboration.paintEvents, height, targetId, width]);

  useEffect(() => {
    activeStrokeIdRef.current = null;
  }, [enabled, targetId]);

  function sendPoint(
    event: ReactPointerEvent<HTMLCanvasElement>,
    phase: CollaborationPaintPoint["phase"],
  ) {
    const strokeId = activeStrokeIdRef.current;
    const point = normalizedPointer(event);
    if (!strokeId || !point) {
      return;
    }
    collaboration.sendPaintPoint({
      targetId,
      strokeId,
      color,
      width: paintWidth,
      phase,
      x: point.x,
      y: point.y,
    });
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    stopPointerEvent(event);
    if (!event.isPrimary || event.button !== 0) {
      return;
    }
    event.currentTarget.focus();
    activeStrokeIdRef.current = crypto.randomUUID();
    lastPointSentAtRef.current = performance.now();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer events do not always create a capturable pointer.
    }
    const point = normalizedPointer(event);
    if (point) {
      collaboration.sendCursor(targetId, point.x * width, point.y * height, { width, height });
    }
    sendPoint(event, "start");
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    stopPointerEvent(event);
    const point = normalizedPointer(event);
    if (point) {
      collaboration.sendCursor(targetId, point.x * width, point.y * height, { width, height });
    }
    if (
      !activeStrokeIdRef.current ||
      performance.now() - lastPointSentAtRef.current < paintSendIntervalMs
    ) {
      return;
    }
    lastPointSentAtRef.current = performance.now();
    sendPoint(event, "move");
  }

  function finishStroke(event: ReactPointerEvent<HTMLCanvasElement>) {
    stopPointerEvent(event);
    if (!activeStrokeIdRef.current) {
      return;
    }
    sendPoint(event, "end");
    activeStrokeIdRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <canvas
      ref={canvasRef}
      tabIndex={-1}
      className={cn(
        "absolute z-20 touch-none",
        enabled ? "cursor-crosshair" : "pointer-events-none",
        !visible && "invisible",
      )}
      style={{ left, top, width, height }}
      aria-label="Shared drawing overlay"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishStroke}
      onPointerCancel={finishStroke}
      onWheel={stopPointerEvent}
      onContextMenu={stopPointerEvent}
    />
  );
}

function normalizedPointer(event: ReactPointerEvent<HTMLCanvasElement>) {
  const rect = event.currentTarget.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    return null;
  }
  return {
    x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
  };
}

function stopPointerEvent(event: { preventDefault: () => void; stopPropagation: () => void }) {
  event.preventDefault();
  event.stopPropagation();
}

function colorForClient(clientId: string) {
  let hash = 0;
  for (const character of clientId) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return paintColors[hash % paintColors.length] ?? "#f43f5e";
}
