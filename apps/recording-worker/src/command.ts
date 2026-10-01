import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { FfmpegFailed, RenderPlatformError } from "./error.js";

const maxDiagnosticCharacters = 4_096;

const ffmpegArguments = [
  "-hide_banner",
  "-nostdin",
  "-loglevel",
  "error",
  "-xerror",
  "-y",
  "-protocol_whitelist",
  "pipe",
  "-f",
  "matroska,webm",
  "-i",
  "pipe:0",
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
  "-f",
  "mp4",
  "edited.mp4",
] as const;

export const runFfmpeg = Effect.fn("recordingWorker.runFfmpeg")(function* (executable: string) {
  const render = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const process = yield* ChildProcess.make(executable, ffmpegArguments, {
      stdin: fs.stream("/dev/fd/3"),
      stdout: "ignore",
      stderr: "pipe",
    });
    const [exitCode, diagnostic] = yield* Effect.all(
      [
        process.exitCode,
        process.stderr.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (tail, chunk) => `${tail}${chunk}`.slice(-maxDiagnosticCharacters),
          ),
        ),
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) {
      return yield* new FfmpegFailed({ exitCode, diagnostic: diagnostic.trim() });
    }
  });

  return yield* Effect.scoped(render).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        new RenderPlatformError({
          message: "ffmpeg could not be run",
          stage: "run-ffmpeg",
          cause,
        }),
      ),
    ),
  );
});
