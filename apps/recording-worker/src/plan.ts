import * as Effect from "effect/Effect";
import { PlanError } from "./error.ts";
import type { RecordingConfig, RecordingTimeline, Burst } from "@aperture-browser/recording/schema";

const zoomMin = 1.1;
const zoomMax = 4;
const zoomEaseMs = 300;
const zoomMinEaseMs = 100;
const rippleMs = 600;
const rippleRadius = 48;
const idleMinMs = 1_500;
const idleKeepMs = 300;
const idleSpeed = 8;
const idleMaxRegions = 100;
const gesturePadMs = 100;
const timelineSpanGapMs = 300;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type Span = { start: number; end: number };
type Piece = Span & { speed: number };
type Cue = Span & { text: string };
type Ripple = { t: number; x: number; y: number };
type ZoomPoint = { t: number; x: number; y: number; level: number };
type FocusedRegion = Span & { point: ZoomPoint };
type ZoomKey = { t: number; zoom: number; x: number; y: number };

export type EditPlan = {
  readonly filter: string;
  readonly ass?: string;
  readonly durationMs: number;
  readonly warnings: readonly string[];
};

export const buildEditPlan = Effect.fn("recordingWorker.buildEditPlan")(function* (
  timeline: RecordingTimeline,
  config: RecordingConfig,
  requestedFps: number,
) {
  const burst = config.capture === "bursts" ? (config.burst ?? {}) : null;
  const ripple = config.ripple ?? config.presentation === true;
  const total = timeline.durationMs;
  let cues = captionCues(timeline.actions, total);
  let focuses = focusedRegions(timeline.focuses);
  let marks = ripples(timeline.gestures, ripple);
  if (
    cues.length === 0 &&
    focuses.length === 0 &&
    marks.length === 0 &&
    config.idle === undefined &&
    burst === null
  ) {
    return undefined;
  }
  const first = timeline.segments[0];
  if (!first || total <= 0) {
    return yield* new PlanError({ message: "the recording has no frames" });
  }
  if (
    timeline.segments.some(
      (segment) => segment.width !== first.width || segment.height !== first.height,
    )
  ) {
    return yield* new PlanError({
      message:
        "the recording's frames change size (its target was resized or replaced by a differently sized one), which effects cannot follow",
    });
  }

  const fps = Math.min(requestedFps, 60);
  const warnings: string[] = [];

  let pieces: Piece[] = [{ start: 0, end: total, speed: 1 }];
  if (burst !== null) {
    const effectWindows: Span[] = [...focuses, ...timeline.attention];
    pieces = burstPieces(timeline, burst, effectWindows);
    if (pieces.length === 0) {
      return yield* new PlanError({
        message:
          "a bursts recording keeps the time around browser tool calls that change something, and this recording has none",
      });
    }
  } else if (config.idle !== undefined) {
    if (!timeline.activity.complete) {
      warnings.push(
        "idle time was preserved because capture or action observations are incomplete",
      );
    } else {
      const busy: Span[] = [
        ...timeline.actions,
        ...timeline.attention,
        ...timeline.gestures.map((gesture) => ({
          start: gesture.start - gesturePadMs,
          end: gesture.end + gesture.hold + gesturePadMs,
        })),
        ...timeline.focuses,
        ...cues,
        ...marks.map((mark) => ({ start: mark.t, end: mark.t + rippleMs })),
        ...timeline.activity.spans.map((span) => ({
          start: span.start - timelineSpanGapMs / 2,
          end: span.end + timelineSpanGapMs / 2,
        })),
      ];
      const idle = idlePieces(config.idle, busy, total);
      if (idle.regions.length === 0) {
        warnings.push(
          "idle was left as it is: no stretch of 1.5 s or more without changes or gestures",
        );
      } else {
        pieces = idle.pieces;
      }
    }
  }

  focuses = groupFocuses(focuses);
  focuses = mapFocusedRegions(pieces, focuses);
  marks = marks.map((mark) => ({ ...mark, t: mapTime(pieces, mark.t) }));
  cues = cues.map((cue) => ({
    ...cue,
    start: mapTime(pieces, cue.start),
    end: mapTime(pieces, cue.end),
  }));

  const renders =
    !isIdentity(pieces, total) || cues.length > 0 || focuses.length > 0 || marks.length > 0;
  if (!renders) return { filter: "", durationMs: total, warnings };

  const filters = ["setpts=PTS-STARTPTS", `fps=fps=${fps}:start_time=0`, "format=yuv420p"];
  if (!isIdentity(pieces, total)) filters.push(...remapFilters(pieces, fps));
  filters.push(...marks.map((mark) => rippleFilter(mark, first.width, fps)));
  filters.push(
    ...focusScenes(focuses, first.width, first.height).map((scene) =>
      zoomFilter(scene, first.width, first.height, fps),
    ),
  );
  filters.push("crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0");
  if (cues.length > 0) filters.push("ass=captions.ass");

  return {
    filter: filters.join(","),
    ...(cues.length > 0 && { ass: marshalAss(cues, first.width, first.height) }),
    durationMs: mapTime(pieces, total),
    warnings,
  };
});

function isIdentity(pieces: readonly Piece[], total: number): boolean {
  return (
    pieces.length === 1 &&
    pieces[0]?.start === 0 &&
    pieces[0].end === total &&
    pieces[0].speed === 1
  );
}

function burstPieces(
  timeline: RecordingTimeline,
  burst: Burst,
  effectWindows: readonly Span[],
): Piece[] {
  const lead = burst.leadMs ?? 150;
  const tail = burst.tailMs ?? 250;
  const settle = burst.settleMs ?? 200;
  const maxTail = burst.maxTailMs ?? Math.max(1_200, tail);
  const watched = timeline.activity.complete;
  const keep: Span[] = [];

  for (const action of timeline.actions) {
    if (!action.ok) continue;
    let end = action.end + tail;
    if (watched) {
      let still = end;
      for (const activity of timeline.activity.spans) {
        if (activity.end > still - settle && activity.start <= still) {
          still = activity.end + settle;
        }
      }
      end = Math.min(still, action.end + maxTail);
    }
    keep.push({
      start: Math.max(action.start - lead, 0),
      end: Math.min(end, timeline.durationMs),
    });
  }
  if (keep.length === 0) return [];
  keep.push(
    ...effectWindows.map((effect) => ({
      start: Math.max(effect.start, 0),
      end: Math.min(effect.end, timeline.durationMs),
    })),
  );
  keep.sort((a, b) => a.start - b.start);

  const pieces: Piece[] = [];
  for (const span of keep) {
    if (span.end <= span.start) continue;
    const previous = pieces.at(-1);
    if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
    else pieces.push({ ...span, speed: 1 });
  }
  return pieces;
}

function captionCues(actions: RecordingTimeline["actions"], total: number): Cue[] {
  const cues: Cue[] = [];
  for (const action of actions) {
    if (!action.ok) continue;
    const text = action.caption?.trim().replaceAll(/\s+/gu, " ") ?? "";
    if (text === "" || action.start >= total) continue;
    const reading = Math.min(
      Math.max(1_000 + 40 * Array.from(graphemeSegmenter.segment(text)).length, 1_200),
      5_000,
    );
    cues.push({
      start: action.start,
      end: Math.min(Math.max(action.end, action.start + reading), total),
      text,
    });
  }
  cues.sort((a, b) => a.start - b.start);
  for (let index = 0; index + 1 < cues.length; index++) {
    const cue = cues[index];
    const next = cues[index + 1];
    if (cue && next) cue.end = Math.min(cue.end, next.start);
  }
  return cues.filter((cue) => cue.end > cue.start);
}

function focusedRegions(focuses: RecordingTimeline["focuses"]): FocusedRegion[] {
  return focuses
    .filter((focus) => focus.end > focus.start && focus.zoom >= zoomMin && focus.zoom <= zoomMax)
    .map((focus) => ({
      start: focus.start,
      end: focus.end,
      point: {
        t: focus.start,
        x: focus.x + focus.width / 2,
        y: focus.y + focus.height / 2,
        level: focus.zoom,
      },
    }))
    .sort((a, b) => a.start - b.start);
}

function ripples(gestures: RecordingTimeline["gestures"], enabled: boolean): Ripple[] {
  const marks: Ripple[] = [];
  for (const gesture of gestures) {
    if (
      gesture.tool !== "browser_click" ||
      (gesture.ripple === undefined && !enabled) ||
      gesture.ripple === false
    ) {
      continue;
    }
    marks.push(...gesture.clicks.map((click) => ({ t: click.t, x: click.x, y: click.y })));
  }
  return marks.sort((a, b) => a.t - b.t);
}

function groupFocuses(focuses: readonly FocusedRegion[]): FocusedRegion[] {
  const grouped: FocusedRegion[] = [];
  for (const focus of focuses) {
    const previous = grouped.at(-1);
    if (
      previous !== undefined &&
      focus.start - previous.end <= 300 &&
      Math.abs(previous.point.level - focus.point.level) < 0.01 &&
      Math.hypot(previous.point.x - focus.point.x, previous.point.y - focus.point.y) < 2
    )
      previous.end = Math.max(previous.end, focus.end);
    else grouped.push({ ...focus });
  }
  return grouped;
}

function mapFocusedRegions(
  pieces: readonly Piece[],
  focuses: readonly FocusedRegion[],
): FocusedRegion[] {
  return focuses.map((focus) => ({
    start: mapTime(pieces, focus.start),
    end: mapTime(pieces, focus.end),
    point: { ...focus.point, t: mapTime(pieces, focus.point.t) },
  }));
}

function focusScenes(
  focuses: readonly FocusedRegion[],
  width: number,
  height: number,
): ZoomKey[][] {
  return focuses.map((focus) => {
    const viewWidth = width / focus.point.level;
    const viewHeight = height / focus.point.level;
    const x = clampView(focus.point.x, viewWidth / 2, width - viewWidth / 2);
    const y = clampView(focus.point.y, viewHeight / 2, height - viewHeight / 2);
    const duration = focus.end - focus.start;
    const ease = Math.min(zoomEaseMs, Math.max(zoomMinEaseMs, duration / 3));
    const arrive = Math.min(focus.start + ease, focus.end);
    const depart = Math.max(arrive, focus.end - ease);
    return [
      { t: focus.start, zoom: 1, x: width / 2, y: height / 2 },
      { t: arrive, zoom: focus.point.level, x, y },
      { t: depart, zoom: focus.point.level, x, y },
      { t: focus.end, zoom: 1, x: width / 2, y: height / 2 },
    ];
  });
}

function clampView(value: number, low: number, high: number): number {
  return high < low ? (low + high) / 2 : Math.max(low, Math.min(value, high));
}

function zoomFilter(scene: readonly ZoomKey[], width: number, height: number, fps: number): string {
  const frames: number[] = [];
  for (const key of scene) {
    const frame = Math.round((key.t * fps) / 1_000);
    frames.push(frames.length === 0 ? frame : Math.max(frame, frames.at(-1)! + 1));
  }
  const edge = (value: (key: ZoomKey) => number): string => {
    let expression = formatNumber(value(scene[0]!));
    for (let index = 0; index + 1 < scene.length; index++) {
      let delta = value(scene[index + 1]!) - value(scene[index]!);
      if (Math.abs(delta) < 5e-4) continue;
      const sign = delta < 0 ? "-" : "+";
      delta = Math.abs(delta);
      expression += `${sign}${formatNumber(delta)}*(1-cos(PI*clip((in-${frames[index]! + 1})/${frames[index + 1]! - frames[index]!},0,1)))/2`;
    }
    return expression;
  };
  const left = edge((key) => key.x - width / (2 * key.zoom));
  const right = edge((key) => key.x + width / (2 * key.zoom));
  const top = edge((key) => key.y - height / (2 * key.zoom));
  const bottom = edge((key) => key.y + height / (2 * key.zoom));
  const enable = `between(t,${((frames[0]! - 0.5) / fps).toFixed(4)},${((frames.at(-1)! + 0.5) / fps).toFixed(4)})`;
  return `perspective=x0='${left}':y0='${top}':x1='${right}':y1='${top}':x2='${left}':y2='${bottom}':x3='${right}':y3='${bottom}':interpolation=cubic:eval=frame:enable='${enable}'`;
}

function formatNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function rippleFilter(mark: Ripple, width: number, fps: number): string {
  const scale = width / 1_280;
  const final = rippleRadius * scale;
  const start = final * 0.3;
  const softness = 3.5 * scale;
  const gap = 2.6 * scale;
  const reach = final + gap + 3 * softness;
  const begin = mark.t / 1_000;
  const duration = rippleMs / 1_000;
  const dx = `X-${mark.x.toFixed(1)}`;
  const dy = `Y-${mark.y.toFixed(1)}`;
  const luma =
    `lum='if(gt(abs(${dx}),${reach.toFixed(0)})+gt(abs(${dy}),${reach.toFixed(0)}),lum(X,Y),` +
    `st(0,clip((T-${begin.toFixed(3)})/${duration.toFixed(1)},0,1));st(1,hypot(${dx},${dy})-${start.toFixed(1)}-${(final - start).toFixed(1)}*(1-pow(1-ld(0),2)));` +
    `st(2,0.95*(1-ld(0))*exp(-pow(ld(1)/${softness.toFixed(1)},2)));st(3,0.65*(1-ld(0))*exp(-pow((ld(1)-${gap.toFixed(1)})/${softness.toFixed(1)},2)));` +
    `(lum(X,Y)+(24-lum(X,Y))*ld(3))*(1-ld(2))+235*ld(2))'`;
  return `geq=${luma}:cb='cb(X,Y)':cr='cr(X,Y)':enable='between(t,${(begin - 0.5 / fps).toFixed(3)},${(begin + duration + 0.5 / fps).toFixed(3)})'`;
}

function idlePieces(
  mode: "cut" | "speed",
  busy: readonly Span[],
  total: number,
): { pieces: Piece[]; regions: Span[] } {
  const merged: Span[] = [];
  for (const source of [...busy].sort((a, b) => a.start - b.start)) {
    const span = { start: Math.max(source.start, 0), end: Math.min(source.end, total) };
    if (span.end < span.start) continue;
    const previous = merged.at(-1);
    if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
    else merged.push(span);
  }
  if (merged.length === 0) {
    if (total < idleMinMs + 2 * idleKeepMs) {
      return { pieces: [{ start: 0, end: total, speed: 1 }], regions: [] };
    }
    const region = { start: idleKeepMs, end: total - idleKeepMs };
    return {
      pieces: [
        { start: 0, end: region.start, speed: 1 },
        ...(mode === "speed" ? [{ ...region, speed: idleSpeed }] : []),
        { start: region.end, end: total, speed: 1 },
      ],
      regions: [region],
    };
  }

  let regions: Span[] = [];
  if (merged[0]!.start >= idleMinMs + idleKeepMs) {
    regions.push({ start: 0, end: merged[0]!.start - idleKeepMs });
  }
  for (let index = 1; index < merged.length; index++) {
    const previous = merged[index - 1]!;
    const current = merged[index]!;
    if (current.start - previous.end >= idleMinMs + 2 * idleKeepMs) {
      regions.push({ start: previous.end + idleKeepMs, end: current.start - idleKeepMs });
    }
  }
  const last = merged.at(-1)!;
  if (total - last.end >= idleMinMs + idleKeepMs) {
    regions.push({ start: last.end + idleKeepMs, end: total });
  }
  if (regions.length > idleMaxRegions) {
    const longest = [...regions]
      .sort((a, b) => b.end - b.start - (a.end - a.start))
      .slice(0, idleMaxRegions);
    regions = regions.filter((region) => longest.includes(region));
  }

  const pieces: Piece[] = [];
  let cursor = 0;
  for (const region of regions) {
    if (region.start > cursor) pieces.push({ start: cursor, end: region.start, speed: 1 });
    if (mode === "speed") pieces.push({ ...region, speed: idleSpeed });
    cursor = region.end;
  }
  if (cursor < total) pieces.push({ start: cursor, end: total, speed: 1 });
  return { pieces, regions };
}

function remapFilters(pieces: readonly Piece[], fps: number): string[] {
  const half = 500 / fps;
  const selects: string[] = [];
  const times: string[] = [];
  for (const piece of pieces) {
    selects.push(
      `gte(t,${(piece.start / 1_000 - half / 1_000).toFixed(4)})*lt(t,${(piece.end / 1_000 - half / 1_000).toFixed(4)})`,
    );
    let term = `(min(max(T,${(piece.start / 1_000).toFixed(3)}),${(piece.end / 1_000).toFixed(3)})-${(piece.start / 1_000).toFixed(3)})`;
    if (piece.speed !== 1) term += `/${piece.speed}`;
    times.push(term);
  }
  return [`select='${selects.join("+")}'`, `setpts='(${times.join("+")})/TB'`, `fps=fps=${fps}`];
}

export function mapTime(pieces: readonly Piece[], time: number): number {
  let output = 0;
  for (const piece of pieces) {
    if (time <= piece.start) break;
    output += (Math.min(time, piece.end) - piece.start) / piece.speed;
  }
  return Math.round(output);
}

function marshalAss(cues: readonly Cue[], width: number, height: number): string {
  const size = Math.max(Math.round(height * 0.045), 12);
  const marginV = Math.round(height * 0.06);
  const marginH = Math.round(width * 0.06);
  const padding = Math.max(Math.round(height * 0.008), 2);
  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,Noto Sans,${size},&H00FFFFFF,&H00FFFFFF,&H30000000,&H30000000,0,0,0,0,100,100,0,0,3,${padding},0,2,${marginH},${marginH},${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const stamp = (milliseconds: number): string => {
    const hours = Math.floor(milliseconds / 3_600_000);
    const minutes = Math.floor(milliseconds / 60_000) % 60;
    const seconds = Math.floor(milliseconds / 1_000) % 60;
    const hundredths = Math.floor((milliseconds % 1_000) / 10);
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}.${hundredths.toString().padStart(2, "0")}`;
  };
  for (const cue of cues) {
    const text = cue.text.replaceAll("\\", "＼").replaceAll("{", "\\{").replaceAll("}", "\\}");
    lines.push(`Dialogue: 0,${stamp(cue.start)},${stamp(cue.end)},Default,,0,0,0,,${text}`);
  }
  return `${lines.join("\n")}\n`;
}
