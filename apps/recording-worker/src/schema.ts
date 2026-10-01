import * as Schema from "effect/Schema";

const Milliseconds = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Coordinate = Schema.Finite;

const TimelineSpan = Schema.Struct({
  start: Milliseconds,
  end: Milliseconds,
});

const TimelineSegment = Schema.Struct({
  targetId: Schema.String,
  start: Milliseconds,
  end: Milliseconds,
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
});

const TimelineAction = Schema.Struct({
  tool: Schema.String,
  startTargetId: Schema.optionalKey(Schema.String),
  targetId: Schema.String,
  start: Milliseconds,
  end: Milliseconds,
  caption: Schema.optionalKey(Schema.String),
  ok: Schema.Boolean,
});

const TimelineClick = Schema.Struct({
  t: Milliseconds,
  x: Coordinate,
  y: Coordinate,
  button: Schema.String,
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

const TimelineScroll = Schema.Struct({
  t: Milliseconds,
  deltaX: Coordinate,
  deltaY: Coordinate,
  x: Coordinate,
  y: Coordinate,
});

const TimelineGesture = Schema.Struct({
  tool: Schema.String,
  targetId: Schema.String,
  start: Milliseconds,
  end: Milliseconds,
  hold: Milliseconds,
  path: Schema.Array(Schema.Tuple([Milliseconds, Coordinate, Coordinate])),
  clicks: Schema.Array(TimelineClick),
  scroll: Schema.optionalKey(TimelineScroll),
  ripple: Schema.optionalKey(Schema.Boolean),
});

const TimelineFocus = Schema.Struct({
  recordingId: Schema.optionalKey(Schema.String),
  targetId: Schema.String,
  start: Milliseconds,
  end: Milliseconds,
  x: Coordinate,
  y: Coordinate,
  width: Coordinate.check(Schema.isGreaterThan(0)),
  height: Coordinate.check(Schema.isGreaterThan(0)),
  zoom: Coordinate.check(Schema.isGreaterThan(0)),
});

export const Timeline = Schema.Struct({
  version: Schema.Literal(1),
  recordingId: Schema.String,
  video: Schema.String,
  durationMs: Milliseconds,
  segments: Schema.Array(TimelineSegment),
  actions: Schema.Array(TimelineAction),
  gestures: Schema.Array(TimelineGesture),
  focuses: Schema.Array(TimelineFocus),
  activity: Schema.Struct({
    complete: Schema.Boolean,
    spans: Schema.Array(TimelineSpan),
  }),
});

const Burst = Schema.Struct({
  leadMs: Schema.optionalKey(Milliseconds),
  tailMs: Schema.optionalKey(Milliseconds),
  settleMs: Schema.optionalKey(Milliseconds),
  maxTailMs: Schema.optionalKey(Milliseconds),
});

export const RenderRequest = Schema.Struct({
  version: Schema.Literal(1),
  ffmpeg: Schema.String,
  fps: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 })),
  effects: Schema.Struct({
    idle: Schema.Literals(["", "cut", "speed"]),
    ripple: Schema.Boolean,
    burst: Schema.NullOr(Burst),
  }),
  timeline: Timeline,
});

export type RenderRequest = typeof RenderRequest.Type;
export type Timeline = typeof Timeline.Type;
export const RenderRequestJson = Schema.fromJsonString(RenderRequest);

export const RenderResult = Schema.Struct({
  version: Schema.Literal(1),
  rendered: Schema.Boolean,
  warnings: Schema.Array(Schema.String),
});

export type RenderResult = typeof RenderResult.Type;
export const RenderResultJson = Schema.fromJsonString(RenderResult);
