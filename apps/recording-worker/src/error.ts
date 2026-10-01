import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

export class InvalidSource extends Schema.TaggedError<InvalidSource>()("InvalidSource", {
  source: Schema.String,
  cause: Schema.instanceOf(Schema.SchemaError),
}) {
  override get message() {
    return `invalid recording source: ${this.source}`;
  }
}
export class SourceReadFailed extends Schema.TaggedError<SourceReadFailed>()("SourceReadFailed", {
  source: Schema.String,
  cause: Schema.instanceOf(PlatformError.PlatformError),
}) {
  override get message() {
    return `recording source could not be read: ${this.source}`;
  }
}
export class OutputWriteFailed extends Schema.TaggedError<OutputWriteFailed>()(
  "OutputWriteFailed",
  {
    output: Schema.String,
    cause: Schema.instanceOf(PlatformError.PlatformError),
  },
) {
  override get message() {
    return `recording output could not be written: ${this.output}`;
  }
}
export class PlanError extends Schema.TaggedError<PlanError>()("PlanError", {
  message: Schema.String,
}) {}
export class RenderStartFailed extends Schema.TaggedError<RenderStartFailed>()(
  "RenderStartFailed",
  {
    cause: Schema.instanceOf(PlatformError.PlatformError),
  },
) {
  override get message() {
    return "FFmpeg could not be started";
  }
}
export class FfmpegFailed extends Schema.TaggedError<FfmpegFailed>()("FfmpegFailed", {
  exitCode: Schema.Int,
  diagnostic: Schema.String,
}) {
  override get message() {
    return `FFmpeg exited with code ${this.exitCode}`;
  }
}
export const FinalizeError = Schema.Union([
  InvalidSource,
  SourceReadFailed,
  OutputWriteFailed,
  PlanError,
  RenderStartFailed,
  FfmpegFailed,
]);
export type FinalizeError = typeof FinalizeError.Type;
