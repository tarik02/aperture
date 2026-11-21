import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { MousePointer2 } from "lucide-react";
import type { Member, Target } from "@aperture-browser/session-client";
import { useSession, useSessionSnapshot } from "../session.tsx";
import { useShownPointers } from "../hooks/use-pointers.ts";
import { useWorkbench } from "../workbench/context.tsx";
import { automationName, memberColor } from "./session-presence.tsx";
import { pictureBox } from "./session-viewport.tsx";

/** How long a stroke that ended takes to fade. */
const STROKE_FADES_MS = 7000;
const STROKE_WIDTH = 4;
/** A stroke that long is thinned out: nobody sees its every point. */
const STROKE_POINTS = 2048;
/** The others are told where a stroke goes this often at most. */
const DRAW_EVERY_MS = 24;
/** And where the pointer that draws is. */
const POINT_EVERY_MS = 40;
/** Of a member who left, or whose colour is not known yet. */
const UNKNOWN_COLOR = "oklch(0.55 0.02 260)";

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Stroke {
  readonly member: number;
  readonly stroke: number;
  points: Point[];
  /** When it ended, on the page's clock; none while it is drawn. */
  endedAt: number | undefined;
}

interface Size {
  readonly width: number;
  readonly height: number;
}

/**
 * What the session's members show each other over the watched tab: where their pointers
 * are, unless this browser was told not to show them, and the strokes they draw. Drawing
 * is this member's while the workbench is told to draw; the picture then takes no input
 * from it, and the others still see where its pointer is.
 */
export function MemberMarks() {
  const session = useSession();
  const snapshot = useSessionSnapshot();
  const { drawing } = useWorkbench();
  const [shownPointers] = useShownPointers();
  const pointed = useRef(0);
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [frame, setFrame] = useState<Size>({ width: 0, height: 0 });
  const [pointers, setPointers] = useState<ReadonlyMap<number, Point>>(new Map());
  const strokes = useRef<Stroke[]>([]);
  const painting = useRef<number | undefined>(undefined);
  const own = useRef<{ stroke: number; told: number } | undefined>(undefined);
  const drawn = useRef(0);

  const { presence } = snapshot;
  const watched = snapshot.targets.find((target) => target.tab === snapshot.selected);
  const box = watched === undefined ? { width: 0, height: 0 } : pictureBox(frame, watched);
  const members = useRef<readonly Member[]>([]);
  members.current = presence?.members ?? [];
  const shown = useRef<{ box: Size; watched: Target | undefined }>({ box, watched });
  shown.current = { box, watched };

  useEffect(() => {
    const element = frameRef.current;
    if (element === null) {
      return undefined;
    }
    const measure = () => setFrame({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const sizes = new ResizeObserver(measure);
    sizes.observe(element);
    return () => sizes.disconnect();
  }, []);

  const paint = useRef(() => {});
  paint.current = () => {
    painting.current = undefined;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    const { box: size, watched: target } = shown.current;
    if (canvas === null || canvas === undefined || context === null || context === undefined) {
      return;
    }
    const now = performance.now();
    strokes.current = strokes.current.filter(
      (stroke) => stroke.endedAt === undefined || now - stroke.endedAt < STROKE_FADES_MS,
    );
    const pixels = window.devicePixelRatio;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (target === undefined || target.width <= 0) {
      return;
    }
    const scale = (size.width / target.width) * pixels;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = STROKE_WIDTH / (size.width / target.width);
    for (const stroke of strokes.current) {
      const member = members.current.find((one) => one.id === stroke.member);
      const color = member === undefined ? UNKNOWN_COLOR : memberColor(member);
      context.globalAlpha =
        stroke.endedAt === undefined ? 1 : 1 - (now - stroke.endedAt) / STROKE_FADES_MS;
      context.strokeStyle = color;
      context.fillStyle = color;
      trace(context, stroke.points);
    }
    if (strokes.current.length > 0) {
      painting.current = requestAnimationFrame(() => paint.current());
    }
  };
  const repaint = () => {
    painting.current ??= requestAnimationFrame(() => paint.current());
  };

  const add = (member: number, stroke: number, phase: "start" | "move" | "end", at: Point) => {
    let open = strokes.current.find(
      (one) => one.member === member && one.stroke === stroke && one.endedAt === undefined,
    );
    if (open === undefined) {
      // A stroke whose start was missed begins where it is first seen.
      open = { member, stroke, points: [], endedAt: undefined };
      strokes.current.push(open);
    }
    open.points.push(at);
    if (open.points.length > STROKE_POINTS) {
      open.points = open.points.filter((_, index) => index % 2 === 0);
    }
    if (phase === "end") {
      open.endedAt = performance.now();
    }
    repaint();
  };
  const addRef = useRef(add);
  addRef.current = add;

  useEffect(() => {
    const unheard = [
      session.onPointer(({ member, at }) =>
        setPointers((before) => {
          const after = new Map(before);
          if (at === undefined) {
            after.delete(member);
          } else {
            after.set(member, at);
          }
          return after;
        }),
      ),
      session.onStroke((point) => addRef.current(point.member, point.stroke, point.phase, point)),
    ];
    return () => {
      for (const unhear of unheard) {
        unhear();
      }
    };
  }, [session]);

  // What was shown over another tab is not shown over this one.
  useEffect(() => {
    setPointers(new Map());
    strokes.current = [];
    own.current = undefined;
    repaint();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- only the tab matters
  }, [snapshot.selected]);

  // Whoever left drew their last, and points nowhere.
  useEffect(() => {
    const here = new Set(presence?.members.map((member) => member.id));
    const now = performance.now();
    for (const stroke of strokes.current) {
      if (stroke.endedAt === undefined && !here.has(stroke.member)) {
        stroke.endedAt = now;
      }
    }
    setPointers((before) => {
      const gone = [...before.keys()].filter((member) => !here.has(member));
      if (gone.length === 0) {
        return before;
      }
      const after = new Map(before);
      for (const member of gone) {
        after.delete(member);
      }
      return after;
    });
  }, [presence]);

  useEffect(() => repaint());

  useEffect(
    () => () => {
      if (painting.current !== undefined) {
        cancelAnimationFrame(painting.current);
      }
    },
    [],
  );

  if (watched === undefined || presence === undefined || box.width <= 0) {
    return (
      <div
        ref={frameRef}
        className="aperture:pointer-events-none aperture:absolute aperture:inset-0"
      />
    );
  }

  const scale = box.width / watched.width;
  const at = (event: ReactPointerEvent<HTMLDivElement>): Point => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) / scale, y: (event.clientY - bounds.top) / scale };
  };
  const draw = (phase: "start" | "move" | "end", point: Point) => {
    const mine = own.current;
    if (mine === undefined) {
      return;
    }
    session.draw(mine.stroke, phase, point);
    add(presence.you, mine.stroke, phase, point);
  };
  const end = (event: ReactPointerEvent<HTMLDivElement>) => {
    draw("end", at(event));
    own.current = undefined;
  };

  return (
    <div
      ref={frameRef}
      className="aperture:pointer-events-none aperture:absolute aperture:inset-0 aperture:z-10 aperture:flex aperture:items-center aperture:justify-center"
    >
      <div
        data-member-marks={drawing ? "drawing" : ""}
        className="aperture:relative aperture:flex-none aperture:overflow-hidden"
        style={{
          width: box.width,
          height: box.height,
          pointerEvents: drawing ? "auto" : "none",
          cursor: drawing ? "crosshair" : undefined,
          touchAction: "none",
        }}
        onPointerDown={(event) => {
          if (!drawing || event.button !== 0) {
            return;
          }
          event.currentTarget.setPointerCapture(event.pointerId);
          drawn.current += 1;
          own.current = { stroke: drawn.current, told: performance.now() };
          draw("start", at(event));
        }}
        onPointerMove={(event) => {
          const now = performance.now();
          if (now - pointed.current >= POINT_EVERY_MS) {
            pointed.current = now;
            session.point(at(event));
          }
          const mine = own.current;
          if (mine === undefined || now - mine.told < DRAW_EVERY_MS) {
            return;
          }
          mine.told = now;
          draw("move", at(event));
        }}
        onPointerLeave={() => session.point()}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <canvas
          ref={canvasRef}
          width={Math.round(box.width * window.devicePixelRatio)}
          height={Math.round(box.height * window.devicePixelRatio)}
          className="aperture:absolute aperture:inset-0 aperture:size-full"
        />
        {(shownPointers ? [...pointers] : []).map(([id, point]) => {
          const member = presence.members.find((one) => one.id === id);
          if (member === undefined) {
            return null;
          }
          return (
            <div
              key={id}
              data-member-pointer={id}
              className="aperture:absolute aperture:top-0 aperture:left-0 aperture:flex aperture:items-start aperture:gap-0.5 aperture:transition-transform aperture:duration-75 aperture:ease-linear"
              style={{
                transform: `translate(${point.x * scale}px, ${point.y * scale}px)`,
                color: memberColor(member),
              }}
            >
              <MousePointer2 className="aperture:size-4 aperture:fill-current aperture:drop-shadow" />
              <span
                className="aperture:mt-3 aperture:max-w-32 aperture:truncate aperture:rounded-full aperture:px-1.5 aperture:py-0.5 aperture:text-[0.625rem] aperture:leading-none aperture:font-medium aperture:text-white aperture:shadow"
                style={{ backgroundColor: memberColor(member) }}
              >
                {member.agent ? automationName(member) : member.name}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Draws a stroke through its points, rounded; one point is a dot. */
function trace(context: CanvasRenderingContext2D, points: readonly Point[]) {
  const [first, ...rest] = points;
  if (first === undefined) {
    return;
  }
  if (rest.length === 0) {
    context.beginPath();
    context.arc(first.x, first.y, context.lineWidth / 2, 0, Math.PI * 2);
    context.fill();
    return;
  }
  context.beginPath();
  context.moveTo(first.x, first.y);
  let last = first;
  for (const point of rest) {
    // Through the middle of each stretch, bent at the points: a hand's line has no corners.
    context.quadraticCurveTo(last.x, last.y, (last.x + point.x) / 2, (last.y + point.y) / 2);
    last = point;
  }
  context.lineTo(last.x, last.y);
  context.stroke();
}
