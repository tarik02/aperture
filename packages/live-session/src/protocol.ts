import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Recording } from "@aperture-browser/api-client";

export const LIVE_SESSION_PROTOCOL = "aperture-session.v1";

export type CollaborationRole = "owner" | "editor" | "viewer";
export type CollaborationLeaseMode = "implicit" | "explicit";
export type CollaborationPhase = "idle" | "connecting" | "connected" | "disconnected";

export interface CollaborationCursor {
  clientId: string;
  targetId: string;
  x: number;
  y: number;
}

export type CollaborationPaintPhase = "start" | "move" | "end";

export interface CollaborationPaintPoint {
  targetId: string;
  strokeId: string;
  color: string;
  width: number;
  phase: CollaborationPaintPhase;
  x: number;
  y: number;
}

export type CollaborationPaintEvent =
  | { type: "point"; message: CollaborationPaintPoint & { clientId: string } }
  | { type: "clear" };

export interface CollaborationError {
  code: string;
  message: string;
}

/**
 * Server messages are decoded strictly: an unknown property means the server speaks a
 * protocol revision this client does not understand.
 */
export const strictParseOptions = { onExcessProperty: "error" } as const;

const int = Schema.Number.check(Schema.isInt());
const positive = Schema.Number.check(Schema.isGreaterThan(0));
const positiveInt = int.check(Schema.isGreaterThan(0));
const unitInterval = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const emptyArray = Effect.succeed([]);

function arrayOrEmpty<S extends Schema.Top>(item: S) {
  return Schema.Array(item).pipe(Schema.withDecodingDefaultKey(emptyArray));
}

const LeaseMode = Schema.Literals(["implicit", "explicit"]);

const PresentationQuality = Schema.Struct({
  profile: Schema.String,
  fps: int.check(Schema.isBetween({ minimum: 1, maximum: 120 })),
  bitrateKbps: int.check(Schema.isGreaterThanOrEqualTo(100)),
  keyframeInterval: positiveInt,
});

const PresentationProfile = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  codec: Schema.String,
  mimeType: Schema.String,
  sdpFmtpLine: Schema.String,
});

const Presentation = Schema.Struct({
  quality: Schema.optionalKey(PresentationQuality),
  profiles: Schema.Array(PresentationProfile),
  cursorVisible: Schema.Boolean,
});

const Target = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  title: Schema.String,
  url: Schema.String,
  loading: Schema.Boolean,
  viewport: Schema.optionalKey(
    Schema.Struct({
      width: positive,
      height: positive,
      contentWidth: positive,
      contentHeight: positive,
      canvasWidth: positive,
      canvasHeight: positive,
      deviceScaleFactor: positive,
    }),
  ),
});

const Participant = Schema.Struct({
  clientId: Schema.String,
  name: Schema.String,
  avatarHash: Schema.String,
  role: Schema.Literals(["owner", "editor", "viewer", "automation"]),
  activeTargetId: Schema.optionalKey(Schema.String),
  followingClientId: Schema.optionalKey(Schema.String),
  holdingInput: Schema.Boolean,
  leaseMode: Schema.optionalKey(LeaseMode),
  recovering: Schema.optionalKey(Schema.Boolean),
});

const Snapshot = Schema.Struct({
  type: Schema.Literal("session.snapshot"),
  clientId: Schema.String,
  resumeSecret: Schema.String,
  role: Schema.Literals(["owner", "editor", "viewer"]),
  transport: Schema.Literals(["webrtc", "websocket"]),
  holderClientId: Schema.optionalKey(Schema.String),
  mode: Schema.optionalKey(LeaseMode),
  activeTargetId: Schema.optionalKey(Schema.String),
  targets: arrayOrEmpty(Target),
  participants: arrayOrEmpty(Participant),
  recordings: arrayOrEmpty(Recording),
  presentation: Presentation,
  viewportOwnerClientId: Schema.optionalKey(Schema.String),
  autoSize: Schema.optionalKey(Schema.Boolean),
});

const PresenceState = Schema.Struct({
  type: Schema.Literal("presence.state"),
  participants: arrayOrEmpty(Participant),
});

const InputState = Schema.Struct({
  type: Schema.Literal("input.state"),
  holderClientId: Schema.optionalKey(Schema.String),
  mode: Schema.optionalKey(LeaseMode),
});

const ViewportState = Schema.Struct({
  type: Schema.Literal("viewport.state"),
  viewportOwnerClientId: Schema.optionalKey(Schema.String),
  autoSize: Schema.Boolean,
});

const Cursor = Schema.Struct({
  type: Schema.Literal("presence.cursor"),
  clientId: Schema.String,
  targetId: Schema.String,
  x: unitInterval,
  y: unitInterval,
  realtimeCounter: positiveInt,
});

const CursorClear = Schema.Struct({
  type: Schema.Literal("presence.cursor.clear"),
  clientId: Schema.String,
  realtimeCounter: positiveInt,
});

const Paint = Schema.Struct({
  type: Schema.Literal("paint.point"),
  clientId: Schema.String,
  targetId: Schema.String,
  strokeId: Schema.String,
  color: Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
  width: Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 16 })),
  phase: Schema.Literals(["start", "move", "end"]),
  x: unitInterval,
  y: unitInterval,
  realtimeCounter: Schema.optionalKey(positiveInt),
});

const TargetsState = Schema.Struct({
  type: Schema.Literal("targets.state"),
  activeTargetId: Schema.optionalKey(Schema.String),
  targets: arrayOrEmpty(Target),
});

const RecordingsState = Schema.Struct({
  type: Schema.Literal("recordings.state"),
  recordings: arrayOrEmpty(Recording),
});

const PresentationState = Schema.Struct({
  type: Schema.Literal("presentation.state"),
  presentation: Presentation,
});

const ErrorMessage = Schema.Struct({
  type: Schema.Literal("error"),
  code: Schema.String,
  message: Schema.String,
});

const CommandResult = Schema.Struct({
  type: Schema.Literals([
    "target.select.result",
    "target.create.result",
    "target.close.result",
    "page.navigate.result",
    "page.history-back.result",
    "page.history-forward.result",
    "page.reload.result",
    "page.stop-loading.result",
    "viewport.set.result",
    "viewport.auto-size.set.result",
    "viewport.owner.claim.result",
    "presentation.quality.set.result",
    "presentation.cursor.set.result",
    "recording.start.result",
    "recording.stop.result",
    "recording.cancel.result",
  ]),
  requestId: Schema.String,
  ok: Schema.Boolean,
  code: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  targetId: Schema.optionalKey(Schema.String),
  recording: Schema.optionalKey(Recording),
  presentation: Schema.optionalKey(Presentation),
});

export const LiveSessionServerMessage = Schema.Union([
  Snapshot,
  PresenceState,
  InputState,
  ViewportState,
  Cursor,
  CursorClear,
  Paint,
  TargetsState,
  RecordingsState,
  PresentationState,
  ErrorMessage,
  CommandResult,
]);

/** Decodes one JSON text frame from the server, or returns undefined when it is invalid. */
export const decodeServerMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(LiveSessionServerMessage),
  strictParseOptions,
);

export type LiveSessionServerMessage = typeof LiveSessionServerMessage.Type;
export type LiveSessionSnapshot = typeof Snapshot.Type;
export type LiveSessionTarget = typeof Target.Type;
export type LiveSessionCommandResult = typeof CommandResult.Type;
export type LiveSessionPresentation = typeof Presentation.Type;
export type LiveSessionPresentationQuality = typeof PresentationQuality.Type;
export type CollaborationParticipant = typeof Participant.Type;

export const RasterFrameHeader = Schema.Struct({
  type: Schema.Literal("presentation.frame"),
  targetId: Schema.String,
  width: positive,
  height: positive,
});

export type LiveSessionRasterFrame = Omit<typeof RasterFrameHeader.Type, "type"> & {
  data: Blob;
};
