import * as Struct from "effect/Struct";
import * as Schema from "effect/Schema";

const ms = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const positive = Schema.Finite.check(Schema.isGreaterThan(0));
const point = Schema.Finite;
const interval = { start: ms, end: ms };
const event = { ...interval, targetId: Schema.String };
const rect = { x: point, y: point, width: positive, height: positive };

export const ApertureCallContext = Schema.Struct({
  cadence: Schema.Literals(["immediate", "recorded", "presentation"]),
  recordingIds: Schema.Array(Schema.String),
});
export type ApertureCallContext = typeof ApertureCallContext.Type;

export const ApertureCallResult = Schema.Struct({
  journal: Schema.Array(Schema.Struct({ recordingId: Schema.String, line: Schema.String })),
  endTargetId: Schema.optionalKey(Schema.String),
  warnings: Schema.Array(Schema.String),
});
export type ApertureCallResult = typeof ApertureCallResult.Type;

export const Action = Schema.Struct({
  _tag: Schema.Literal("Action"),
  ...event,
  tool: Schema.String,
  startTargetId: Schema.String,
  caption: Schema.optionalKey(Schema.String),
  ok: Schema.Boolean,
});
const click = Schema.Struct({
  t: ms,
  x: point,
  y: point,
  button: Schema.Literals(["left", "right", "middle"]),
  count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
});
export const Gesture = Schema.Struct({
  _tag: Schema.Literal("Gesture"),
  ...event,
  tool: Schema.String,
  space: Schema.Literals(["viewport", "compositor"]),
  hold: ms,
  path: Schema.Array(Schema.Tuple([ms, point, point])),
  clicks: Schema.Array(click),
  scroll: Schema.optionalKey(
    Schema.Struct({ t: ms, x: point, y: point, deltaX: point, deltaY: point }),
  ),
  ripple: Schema.optionalKey(Schema.Boolean),
});
export const Focus = Schema.Struct({
  _tag: Schema.Literal("Focus"),
  ...event,
  ...rect,
  zoom: Schema.Finite.check(Schema.isBetween({ minimum: 1.1, maximum: 4 })),
});
export const Attention = Schema.Struct({
  _tag: Schema.Literal("Attention"),
  ...event,
  x: point,
  y: point,
  radius: positive,
});
export const RecordingEvent = Schema.Union([Action, Gesture, Focus, Attention]);
export type RecordingEvent = typeof RecordingEvent.Type;
export const RecordingEventJson = Schema.fromJsonString(RecordingEvent);
export const ActionSource = Schema.Array(RecordingEvent);
export type ActionSource = typeof ActionSource.Type;

const burstDuration = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 60000 }));
export const Burst = Schema.Struct({
  leadMs: Schema.optionalKey(burstDuration),
  tailMs: Schema.optionalKey(burstDuration),
  settleMs: Schema.optionalKey(burstDuration),
  maxTailMs: Schema.optionalKey(burstDuration),
});
export type Burst = typeof Burst.Type;
export const RecordingConfig = Schema.Struct({
  capture: Schema.optionalKey(Schema.Literals(["continuous", "bursts"])),
  presentation: Schema.optionalKey(Schema.Boolean),
  idle: Schema.optionalKey(Schema.Literals(["cut", "speed"])),
  ripple: Schema.optionalKey(Schema.Boolean),
  burst: Schema.optionalKey(Burst),
}).check(
  Schema.makeFilter((config) => {
    if (config.capture === "bursts" && config.idle !== undefined) {
      return "bursts and idle are mutually exclusive";
    }
    if (config.burst !== undefined && config.capture !== "bursts") {
      return "burst requires capture: bursts";
    }
    return true;
  }),
);
export type RecordingConfig = typeof RecordingConfig.Type;

export const CaptureSegment = Schema.Struct({
  targetId: Schema.String,
  firstFrameMs: ms,
  durationMs: positive,
  width: positive,
  height: positive,
  viewportScaleX: positive,
  viewportScaleY: positive,
  compositorScaleX: positive,
  compositorScaleY: positive,
  damage: Schema.Array(ms),
});
export const CaptureSource = Schema.Struct({
  version: Schema.Literal(1),
  recordingId: Schema.String,
  video: Schema.Literals(["raw.webm", "raw.mkv"]),
  fps: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 120 })),
  segments: Schema.Array(CaptureSegment),
  activityComplete: Schema.Boolean,
  actionsComplete: Schema.Boolean,
  warnings: Schema.Array(Schema.String),
});
export type CaptureSource = typeof CaptureSource.Type;

export const TimelineSegment = Schema.Struct({
  ...interval,
  targetId: Schema.String,
  width: positive,
  height: positive,
});
export type TimelineSegment = typeof TimelineSegment.Type;
export const TimelineAction = Schema.Struct(Struct.omit(Action.fields, ["_tag"]));
export type TimelineAction = typeof TimelineAction.Type;
export const TimelineGesture = Schema.Struct(Struct.omit(Gesture.fields, ["_tag", "space"]));
export type TimelineGesture = typeof TimelineGesture.Type;
export const TimelineFocus = Schema.Struct(Struct.omit(Focus.fields, ["_tag"]));
export type TimelineFocus = typeof TimelineFocus.Type;
export const TimelineAttention = Schema.Struct(Struct.omit(Attention.fields, ["_tag"]));
export type TimelineAttention = typeof TimelineAttention.Type;

export const RecordingTimeline = Schema.Struct({
  version: Schema.Literal(1),
  recordingId: Schema.String,
  video: Schema.String,
  durationMs: ms,
  segments: Schema.Array(TimelineSegment),
  actions: Schema.Array(TimelineAction),
  gestures: Schema.Array(TimelineGesture),
  focuses: Schema.Array(TimelineFocus),
  attention: Schema.Array(TimelineAttention),
  activity: Schema.Struct({
    complete: Schema.Boolean,
    spans: Schema.Array(Schema.Struct(interval)),
  }),
});
export type RecordingTimeline = typeof RecordingTimeline.Type;

export const FinalizeInput = Schema.Struct({ ffmpeg: Schema.String });
export const FinalizeResult = Schema.Struct({
  version: Schema.Literal(1),
  timeline: Schema.Boolean,
  edited: Schema.Boolean,
  warnings: Schema.Array(Schema.String),
});
export type FinalizeResult = typeof FinalizeResult.Type;
