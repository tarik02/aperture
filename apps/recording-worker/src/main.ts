import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import {
  CaptureSource,
  FinalizeInput,
  FinalizeResult,
  RecordingConfig,
  RecordingEventJson,
  RecordingTimeline,
} from "@aperture-browser/recording/schema";
import {
  FfmpegFailed,
  InvalidSource,
  OutputWriteFailed,
  RenderStartFailed,
  SourceReadFailed,
} from "./error.ts";
import { buildTimeline } from "./timeline.ts";
import { buildEditPlan } from "./plan.ts";

const readSource = Effect.fn("recording.readSource")(function* <A>(
  source: string,
  schema: Schema.Codec<A, string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(source)
    .pipe(Effect.mapError((cause) => new SourceReadFailed({ source, cause })));
  return yield* Schema.decodeEffect(schema)(text).pipe(
    Effect.mapError((cause) => new InvalidSource({ source, cause })),
  );
});
const writeOutput = Effect.fn("recording.writeOutput")(function* (output: string, text: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs
    .writeFileString(output, text)
    .pipe(Effect.mapError((cause) => new OutputWriteFailed({ output, cause })));
});
const render = Effect.fn("recording.render")(function* (ffmpeg: string, video: string) {
  const renderProcess = Effect.gen(function* () {
    const path = yield* Path.Path;
    const process = yield* ChildProcess.make(
      ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-xerror",
        "-n",
        "-i",
        video,
        "-map",
        "0:v:0",
        "-an",
        "-sn",
        "-dn",
        "-/vf",
        "filter.txt",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-fps_mode",
        "passthrough",
        "-movflags",
        "+faststart",
        "edited.mp4",
      ],
      {
        cwd: path.resolve("."),
        detached: false,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const [exitCode, diagnostic] = yield* Effect.all(
      [
        process.exitCode,
        process.stderr.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (tail, chunk) => `${tail}${chunk}`.slice(-4096),
          ),
        ),
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) return yield* new FfmpegFailed({ exitCode, diagnostic });
  });
  yield* Effect.scoped(renderProcess).pipe(
    Effect.catchTag("PlatformError", (cause) => Effect.fail(new RenderStartFailed({ cause }))),
  );
});

const finalize = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const requestText = yield* stdio.stdin.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (text, chunk) => text + chunk,
    ),
  );
  const request = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(FinalizeInput))(
    requestText,
  ).pipe(Effect.mapError((cause) => new InvalidSource({ source: "process input", cause })));
  const capture = yield* readSource("capture.json", Schema.fromJsonString(CaptureSource));
  const config = yield* readSource("config.json", Schema.fromJsonString(RecordingConfig));
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString("actions.ndjson")
    .pipe(Effect.mapError((cause) => new SourceReadFailed({ source: "actions.ndjson", cause })));
  const events = yield* Effect.forEach(
    text.split("\n").filter((line) => line !== ""),
    (line) =>
      Schema.decodeUnknownEffect(RecordingEventJson)(line).pipe(
        Effect.mapError((cause) => new InvalidSource({ source: "actions.ndjson", cause })),
      ),
  );
  const { timeline, warnings } = yield* buildTimeline(capture, events);
  const encodedTimeline = yield* Schema.encodeEffect(Schema.fromJsonString(RecordingTimeline))(
    timeline,
  );
  yield* writeOutput("timeline.json", encodedTimeline);
  const outcome = yield* Effect.gen(function* () {
    const plan = yield* buildEditPlan(timeline, config, capture.fps);
    if (plan === undefined || plan.filter === "")
      return { edited: false, warnings: plan?.warnings ?? [] };
    yield* writeOutput("filter.txt", plan.filter);
    if (plan.ass !== undefined) yield* writeOutput("captions.ass", plan.ass);
    yield* render(request.ffmpeg, capture.video);
    return { edited: true, warnings: plan.warnings };
  }).pipe(
    Effect.catchTags({
      PlanError: (error) => Effect.succeed({ edited: false, warnings: [error.message] }),
      OutputWriteFailed: (error) => Effect.succeed({ edited: false, warnings: [error.message] }),
      RenderStartFailed: (error) => Effect.succeed({ edited: false, warnings: [error.message] }),
      FfmpegFailed: (error) => Effect.succeed({ edited: false, warnings: [error.message] }),
    }),
  );
  const result = yield* Schema.encodeEffect(Schema.fromJsonString(FinalizeResult))({
    version: 1,
    timeline: true,
    edited: outcome.edited,
    warnings: [...warnings, ...outcome.warnings],
  });
  yield* Stream.make(`${result}\n`).pipe(Stream.run(stdio.stdout()));
});
NodeRuntime.runMain(finalize.pipe(Effect.provide(NodeServices.layer)));
