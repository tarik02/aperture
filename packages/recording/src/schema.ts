import * as Struct from "effect/Struct";
import * as Schema from "effect/Schema";

const ms = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const positive = Schema.Finite.check(Schema.isGreaterThan(0));
const point = Schema.Finite;
const interval = { start: ms, end: ms };
const event = { ...interval, targetId: Schema.String };
const rect = { x: point, y: point, width: positive, height: positive };

export const ActionReveal = Schema.Struct(interval).check(
  Schema.makeFilter((reveal) => reveal.end >= reveal.start || "reveal ends before it starts"),
);
export type ActionReveal = typeof ActionReveal.Type;

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
  reveal: Schema.optionalKey(ActionReveal),
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

export const RecordingEdit = Schema.Struct({
  trim: Schema.optionalKey(Schema.Literals(["none", "idle", "actions"])),
  cutStyle: Schema.optionalKey(Schema.Literals(["natural", "tight"])),
  ripple: Schema.optionalKey(Schema.Boolean),
});
export type RecordingEdit = typeof RecordingEdit.Type;

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
