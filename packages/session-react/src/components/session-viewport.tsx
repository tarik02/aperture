import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useSession, useSessionSnapshot } from "../session.tsx";

export interface SessionViewportProps {
  readonly className?: string | undefined;
  readonly style?: CSSProperties | undefined;
  /** Laid over the picture, such as the connection's state. */
  readonly children?: ReactNode;
}

const PICTURE_WITHIN_MS = 1000;
/** How long after the room for the picture last changed it counts as still changing. */
const RESIZED_AFTER_MS = 200;
const SETTLING_BLUR_PX = 6;
const SETTLING_FADE_MS = 160;

interface Size {
  readonly width: number;
  readonly height: number;
}

/**
 * The watched target's picture, and its input: the pointer, the wheel, the keyboard, the
 * clipboard and what is dropped on it. The picture is shown at the target's own size, and
 * smaller where the stage has no room for that.
 */
export function SessionViewport({ className, style, children }: SessionViewportProps) {
  const session = useSession();
  const snapshot = useSessionSnapshot();
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const keysRef = useRef<HTMLTextAreaElement>(null);
  const [stage, setStage] = useState<Size>({ width: 0, height: 0 });
  /** The size of the picture that is drawn now, in its own pixels. */
  const [drawn, setDrawn] = useState<Size>({ width: 0, height: 0 });
  /** Whether the room for the picture is being changed, as by dragging the window's edge. */
  const [resizing, setResizing] = useState(false);
  const way = snapshot.picture.way;

  useEffect(() => {
    const surfaces = {
      video: videoRef.current,
      canvas: canvasRef.current,
      keys: keysRef.current,
      stage: stageRef.current,
    };
    if (
      surfaces.video === null ||
      surfaces.canvas === null ||
      surfaces.keys === null ||
      surfaces.stage === null
    ) {
      return undefined;
    }
    return session.attach({
      video: surfaces.video,
      canvas: surfaces.canvas,
      keys: surfaces.keys,
      stage: surfaces.stage,
    });
  }, [session]);

  useEffect(() => {
    const element = stageRef.current;
    if (element === null) {
      return undefined;
    }
    let settling: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      const next = { width: element.clientWidth, height: element.clientHeight };
      setStage((before) => {
        // The first measure is no change of size, and neither is one that measures the same.
        if (before.width > 0 && (before.width !== next.width || before.height !== next.height)) {
          setResizing(true);
          clearTimeout(settling);
          settling = setTimeout(() => setResizing(false), RESIZED_AFTER_MS);
        }
        return next;
      });
    };
    measure();
    const sizes = new ResizeObserver(measure);
    sizes.observe(element);
    return () => {
      sizes.disconnect();
      clearTimeout(settling);
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (video === null || canvas === null) {
      return undefined;
    }
    const measure = () => {
      const size =
        way === "video"
          ? { width: video.videoWidth, height: video.videoHeight }
          : { width: canvas.width, height: canvas.height };
      setDrawn((before) =>
        before.width === size.width && before.height === size.height ? before : size,
      );
    };
    measure();
    video.addEventListener("resize", measure);
    video.addEventListener("loadedmetadata", measure);
    // A canvas says nothing when what is drawn into it changes its size.
    const sizes = new MutationObserver(measure);
    sizes.observe(canvas, { attributes: true, attributeFilter: ["width", "height"] });
    return () => {
      video.removeEventListener("resize", measure);
      video.removeEventListener("loadedmetadata", measure);
      sizes.disconnect();
    };
  }, [way]);

  const watched = snapshot.targets.find((target) => target.tab === snapshot.selected);
  const shown = watched === undefined ? undefined : way;
  // The picture of another tab, or of this one at another size, comes a moment after the
  // session says which tab is watched and how large it is. Until what is drawn has the
  // shape of what is watched, the picture keeps the place it had: the place and the
  // picture change together.
  const awaited =
    watched !== undefined && drawn.width > 0 && !sameShape(drawn, watched)
      ? `${watched.id} ${watched.width}x${watched.height}`
      : undefined;
  // A picture that does not come is not waited for longer than this.
  const [overdue, setOverdue] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (awaited === undefined) {
      return undefined;
    }
    const waiting = setTimeout(() => setOverdue(awaited), PICTURE_WITHIN_MS);
    return () => clearTimeout(waiting);
  }, [awaited]);
  const settled = awaited === undefined || awaited === overdue;
  const placed = useRef<Size | undefined>(undefined);
  if (settled) {
    placed.current = watched === undefined ? undefined : pictureBox(stage, watched);
  }
  const box = placed.current ?? (watched === undefined ? undefined : pictureBox(stage, watched));

  const picture = (visible: boolean): CSSProperties => ({
    display: visible ? "block" : "none",
    flex: "none",
    width: box?.width,
    height: box?.height,
    outline: "none",
    // A touch that drags is the session's pointer, not a scroll of this page.
    touchAction: "none",
    cursor: snapshot.cursor,
    // While its room changes and until the picture of the new size is there, what is
    // drawn is stretched or stale: softened, it reads as settling and not as broken.
    filter: resizing || !settled ? `blur(${SETTLING_BLUR_PX}px)` : "none",
    transition: `filter ${SETTLING_FADE_MS}ms ease-out`,
  });

  return (
    <div
      ref={stageRef}
      className={className}
      data-aperture-stage=""
      style={{
        position: "relative",
        display: "flex",
        flex: "1 1 0%",
        minWidth: 0,
        minHeight: 0,
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        ...style,
      }}
    >
      <video
        ref={videoRef}
        data-aperture-surface="video"
        tabIndex={-1}
        autoPlay
        muted
        playsInline
        style={picture(shown === "video")}
      />
      <canvas
        ref={canvasRef}
        data-aperture-surface="canvas"
        tabIndex={-1}
        style={picture(shown === "frames" || shown === "tiles")}
      />
      <textarea
        ref={keysRef}
        data-aperture-surface="keys"
        aria-label="Keyboard of the session"
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        style={{
          position: "absolute",
          left: 0,
          bottom: 0,
          width: 1,
          height: 1,
          padding: 0,
          border: 0,
          opacity: 0,
          resize: "none",
          // A phone zooms into a field whose text is smaller than this.
          fontSize: 16,
        }}
      />
      {children}
    </div>
  );
}

/** Whether two sizes have the same proportions, give or take a pixel's rounding. */
function sameShape(one: Size, other: Size): boolean {
  if (one.height <= 0 || other.height <= 0) {
    return false;
  }
  const ratio = (one.width / one.height) * (other.height / other.width);
  return Math.abs(ratio - 1) < 0.01;
}

/** The place the picture of a target has in a stage: its own size, or smaller to fit. */
export function pictureBox(stage: Size, target: Size): Size {
  if (target.width <= 0 || target.height <= 0) {
    return { width: 0, height: 0 };
  }
  const scale = Math.min(1, stage.width / target.width, stage.height / target.height);
  return {
    width: Math.floor(target.width * scale),
    height: Math.floor(target.height * scale),
  };
}
