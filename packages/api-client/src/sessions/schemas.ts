import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Api from "@aperture-browser/api-schema";

// The live session endpoints are not part of api/openapi.yaml.

const positiveInt = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));
const emptyArray = Effect.succeed([]);

export const BrowserStatus = Schema.Struct({
  sessionId: Schema.String,
  cdpUrl: Schema.String,
  media: Api.SessionMedia,
  targets: Schema.Array(
    Schema.Struct({
      targetId: Schema.String,
      generation: positiveInt,
      state: Schema.Literals(["pending", "ready", "unavailable", "closed"]),
      title: Schema.String,
      url: Schema.String,
      viewport: Schema.Struct({
        width: positiveInt,
        height: positiveInt,
        deviceScaleFactor: Schema.Number.check(Schema.isGreaterThan(0)),
        contentWidth: positiveInt,
        contentHeight: positiveInt,
        canvasWidth: positiveInt,
        canvasHeight: positiveInt,
      }),
    }),
  ).pipe(Schema.withDecodingDefaultKey(emptyArray)),
});

/** A recording as the live session reports it. */
export const Recording = Schema.Struct({
  recordingId: Schema.String,
  mode: Schema.Literals(["tab", "viewer"]),
  targetId: Schema.String,
  captureGeneration: positiveInt,
  status: Schema.Literals(["starting", "running", "stopped", "failed"]),
  stopReason: Schema.optionalKey(Schema.String),
  relativePath: Schema.String,
  sandboxPath: Schema.optionalKey(Schema.String),
  startedAt: Schema.String,
  stoppedAt: Schema.optionalKey(Schema.String),
  sizeBytes: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  fps: positiveInt,
  bitrateKbps: positiveInt,
  codec: Schema.String,
});

export type BrowserStatus = typeof BrowserStatus.Type;
export type Recording = typeof Recording.Type;
