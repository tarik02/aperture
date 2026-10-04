import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Api from "@aperture-browser/api-schema";

// The live session endpoints are not part of api/openapi.yaml.

const positiveInt = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));
const emptyArray = Effect.succeed([]);

export const RecordingSettings = Schema.Struct({
  capture: Api.CreateSessionRecordingInput.fields.capture,
  presentation: Api.CreateSessionRecordingInput.fields.presentation,
  idle: Api.CreateSessionRecordingInput.fields.idle,
  ripple: Api.CreateSessionRecordingInput.fields.ripple,
  burst: Api.CreateSessionRecordingInput.fields.burst,
});
export type RecordingSettings = typeof RecordingSettings.Type;

export const BrowserPage = Schema.Struct({
  targetId: Schema.String,
  state: Schema.Literals(["pending", "ready", "unavailable", "closed"]),
  title: Schema.String,
  url: Schema.String,
  viewport: Schema.optionalKey(
    Schema.Struct({
      width: positiveInt,
      height: positiveInt,
      deviceScaleFactor: Schema.Number.check(Schema.isGreaterThan(0)),
      contentWidth: positiveInt,
      contentHeight: positiveInt,
      canvasWidth: positiveInt,
      canvasHeight: positiveInt,
    }),
  ),
  thumbnailAvailable: Schema.Boolean,
});

const browserStatusCommon = {
  sessionId: Schema.String,
  cdpUrl: Schema.String,
  media: Api.SessionMedia,
  thumbnailAvailable: Schema.Boolean,
  pages: Schema.Array(BrowserPage).pipe(Schema.withDecodingDefaultKey(emptyArray)),
};

const availableBrowserStatus = {
  ...browserStatusCommon,
  capturedAt: Schema.String,
  representativeTargetId: Schema.optionalKey(Schema.String),
};

/** Passive page discovery. Reading it never wakes or keeps a browser session alive. */
export const BrowserStatus = Schema.Union([
  Schema.Struct({
    ...availableBrowserStatus,
    status: Schema.Literal("running"),
    source: Schema.Literal("live"),
  }),
  Schema.Struct({
    ...availableBrowserStatus,
    status: Schema.Literal("suspended"),
    source: Schema.Literal("persisted"),
  }),
  Schema.Struct({
    ...browserStatusCommon,
    status: Schema.Literal("suspended"),
    source: Schema.Literal("unavailable"),
  }),
]);

const recordingFields = {
  recordingId: Schema.String,
  mode: Schema.Literals(["tab", "viewer"]),
  targetId: Schema.String,
  captureGeneration: positiveInt,
  status: Schema.Literals(["starting", "running", "stopped", "failed"]),
  stopReason: Schema.optionalKey(Schema.String),
  sandboxPath: Schema.optionalKey(Schema.String),
  /** @deprecated Read `relativePath`. Sessions started before it existed send only this. */
  path: Schema.optionalKey(Schema.String),
  startedAt: Schema.String,
  stoppedAt: Schema.optionalKey(Schema.String),
  sizeBytes: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  fps: positiveInt,
  bitrateKbps: positiveInt,
  codec: Schema.String,
  /** The stop returned and the edit is still running; `editedRelativePath` or `editError` follows. */
  editing: Schema.Boolean,
  editedRelativePath: Schema.optionalKey(Schema.String),
  timelineRelativePath: Schema.optionalKey(Schema.String),
  editError: Schema.optionalKey(Api.RecordingEditError),
};

/**
 * A recording as the live session reports it. Sessions that are still running an
 * older wrapper send only `path`, which decoding carries over into `relativePath`.
 */
export const Recording = Schema.Struct({
  ...recordingFields,
  relativePath: Schema.optionalKey(Schema.String),
}).pipe(
  Schema.decodeTo(
    Schema.Struct({ ...recordingFields, relativePath: Schema.String }),
    SchemaTransformation.transform({
      decode: ({ relativePath, ...recording }) => ({
        ...recording,
        relativePath: relativePath ?? recording.path ?? "",
      }),
      encode: (recording) => recording,
    }),
  ),
);

export type BrowserStatus = typeof BrowserStatus.Type;
export type BrowserPage = typeof BrowserPage.Type;
export type Recording = typeof Recording.Type;
