import * as PlatformError from "effect/PlatformError";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";

export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()("InvalidRequest", {
  message: Schema.String,
  cause: Schema.instanceOf(Schema.SchemaError),
}) {
  readonly [Runtime.errorExitCode] = 2;
}

export class RenderPlatformError extends Schema.TaggedError<RenderPlatformError>()(
  "RenderPlatformError",
  {
    message: Schema.String,
    stage: Schema.Literals(["read-request", "write-plan", "run-ffmpeg", "write-result"]),
    cause: Schema.instanceOf(PlatformError.PlatformError),
  },
) {
  readonly [Runtime.errorExitCode] = 1;
}

export class FfmpegFailed extends Schema.TaggedError<FfmpegFailed>()("FfmpegFailed", {
  exitCode: Schema.Int,
  diagnostic: Schema.String,
}) {
  readonly [Runtime.errorExitCode] = 1;

  override get message(): string {
    return `ffmpeg exited with code ${this.exitCode}`;
  }
}

export class PlanError extends Schema.TaggedError<PlanError>()("PlanError", {
  message: Schema.String,
}) {
  readonly [Runtime.errorExitCode] = 1;
}

export type RenderError = InvalidRequest | RenderPlatformError | FfmpegFailed | PlanError;
