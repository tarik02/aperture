import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { runFfmpeg } from "./command.js";
import { FfmpegFailed, InvalidRequest, RenderPlatformError, type RenderError } from "./error.js";
import { buildEditPlan } from "./plan.js";
import { RenderRequestJson, RenderResultJson, type RenderResult } from "./schema.js";

const readRequest = FileSystem.FileSystem.use((fs) => fs.readFileString("/dev/stdin")).pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(RenderRequestJson)),
  Effect.catchTags({
    PlatformError: (cause) =>
      Effect.fail(
        new RenderPlatformError({
          message: "render request could not be read",
          stage: "read-request",
          cause,
        }),
      ),
    SchemaError: (cause) =>
      Effect.fail(new InvalidRequest({ message: "render request is invalid", cause })),
  }),
);

const main = Effect.gen(function* () {
  const request = yield* readRequest;
  const plan = yield* buildEditPlan(request.timeline, request.effects, request.fps);
  const result: RenderResult = {
    version: 1,
    rendered: plan !== undefined && plan.filter !== "",
    warnings: plan?.warnings ?? [],
  };

  if (plan !== undefined && plan.filter !== "") {
    const fs = yield* FileSystem.FileSystem;
    yield* Effect.gen(function* () {
      yield* fs.writeFileString("filter.txt", plan.filter);
      if (plan.ass !== undefined) yield* fs.writeFileString("captions.ass", plan.ass);
    }).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(
          new RenderPlatformError({
            message: "render plan could not be written",
            stage: "write-plan",
            cause,
          }),
        ),
      ),
    );
    yield* runFfmpeg(request.ffmpeg);
  }

  const encoded = yield* Schema.encodeEffect(RenderResultJson)(result).pipe(Effect.orDie);
  const stdio = yield* Stdio.Stdio;
  yield* Stream.make(`${encoded}\n`).pipe(
    Stream.run(stdio.stdout()),
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        new RenderPlatformError({
          message: "render result could not be written",
          stage: "write-result",
          cause,
        }),
      ),
    ),
  );
});

const reportFailure = Effect.fn("recordingWorker.reportFailure")(function* (error: RenderError) {
  const stdio = yield* Stdio.Stdio;
  const diagnostic =
    error instanceof FfmpegFailed && error.diagnostic !== ""
      ? `${error.message}: ${error.diagnostic}`
      : error.message;
  yield* Stream.make(`${diagnostic}\n`).pipe(Stream.run(stdio.stderr()), Effect.ignore);
});

const program = main.pipe(Effect.tapError(reportFailure), Effect.provide(NodeServices.layer));

NodeRuntime.runMain(program, { disableErrorReporting: true });
