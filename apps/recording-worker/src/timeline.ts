import * as Effect from "effect/Effect";
import {
  type ActionSource,
  type CaptureSource,
  type RecordingTimeline,
  type RecordingEvent,
} from "@aperture-browser/recording/schema";
import { PlanError } from "./error.ts";

// Capture offsets are cumulative: segment wall-clock intervals may overlap while
// a replacement pipeline starts, but the joined video contains both segments.
export const buildTimeline = Effect.fn("recording.buildTimeline")(function* (
  capture: CaptureSource,
  events: ActionSource,
) {
  if (capture.segments.length === 0)
    return yield* new PlanError({ message: "recording has no capture segments" });
  const actions: RecordingTimeline["actions"][number][] = [];
  const gestures: RecordingTimeline["gestures"][number][] = [];
  const focuses: RecordingTimeline["focuses"][number][] = [];
  const attention: RecordingTimeline["attention"][number][] = [];
  const segments: RecordingTimeline["segments"][number][] = [];
  const damage: number[] = [];
  let offset = 0;
  const warnings = [...capture.warnings];
  if (!capture.actionsComplete) warnings.push("browser action source is incomplete");
  if (!capture.activityComplete) warnings.push("capture activity source is incomplete");
  for (const segment of capture.segments) {
    const wallEnd = segment.firstFrameMs + segment.durationMs;
    const videoEnd = offset + segment.durationMs;
    const time = (wall: number) =>
      Math.max(offset, Math.min(videoEnd, offset + wall - segment.firstFrameMs));
    const overlaps = (event: RecordingEvent) =>
      (event._tag === "Action" || event.targetId === segment.targetId) &&
      event.start < wallEnd &&
      event.end >= segment.firstFrameMs;
    segments.push({
      targetId: segment.targetId,
      start: offset,
      end: videoEnd,
      width: segment.width,
      height: segment.height,
    });
    for (const at of segment.damage)
      if (at >= segment.firstFrameMs && at < wallEnd) damage.push(time(at));
    for (const event of events) {
      if (event.end < event.start)
        return yield* new PlanError({ message: "recording event ends before it starts" });
      if (!overlaps(event)) continue;
      switch (event._tag) {
        case "Action": {
          const { _tag, ...action } = event;
          actions.push({ ...action, start: time(event.start), end: time(event.end) });
          if (!event.ok) warnings.push(`browser action failed: ${event.tool}`);
          break;
        }
        case "Gesture": {
          const { _tag, space, ...gesture } = event;
          const sx = space === "viewport" ? segment.viewportScaleX : segment.compositorScaleX;
          const sy = space === "viewport" ? segment.viewportScaleY : segment.compositorScaleY;
          const inside = (at: number) => at >= segment.firstFrameMs && at < wallEnd;
          gestures.push({
            ...gesture,
            start: time(event.start),
            end: time(event.end),
            path: event.path
              .filter(([at]) => inside(at))
              .map(([at, x, y]) => [time(at), x * sx, y * sy]),
            clicks: event.clicks
              .filter((click) => inside(click.t))
              .map((click) => ({ ...click, t: time(click.t), x: click.x * sx, y: click.y * sy })),
            ...(event.scroll === undefined
              ? {}
              : {
                  scroll: {
                    ...event.scroll,
                    t: time(event.scroll.t),
                    x: event.scroll.x * sx,
                    y: event.scroll.y * sy,
                  },
                }),
          });
          break;
        }
        case "Focus": {
          const { _tag, ...focus } = event;
          focuses.push({
            ...focus,
            start: time(event.start),
            end: time(event.end),
            x: event.x * segment.viewportScaleX,
            y: event.y * segment.viewportScaleY,
            width: event.width * segment.viewportScaleX,
            height: event.height * segment.viewportScaleY,
          });
          break;
        }
        case "Attention": {
          const { _tag, ...mark } = event;
          attention.push({
            ...mark,
            start: time(event.start),
            end: time(event.end),
            x: event.x * segment.viewportScaleX,
            y: event.y * segment.viewportScaleY,
            radius: event.radius * segment.viewportScaleX,
          });
          break;
        }
      }
    }
    offset = videoEnd;
  }
  const spans: { start: number; end: number }[] = [];
  for (const at of damage.sort((a, b) => a - b)) {
    const last = spans.at(-1);
    if (last !== undefined && at - last.end <= 300) last.end = at;
    else spans.push({ start: at, end: at });
  }
  return {
    timeline: {
      version: 1,
      recordingId: capture.recordingId,
      video: capture.video,
      durationMs: offset,
      segments,
      actions,
      gestures,
      focuses,
      attention,
      activity: { complete: capture.activityComplete && capture.actionsComplete, spans },
    } satisfies RecordingTimeline,
    warnings: [...new Set(warnings)],
  };
});
