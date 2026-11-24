import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ffmpeg } from "./programs.ts";

/** A place in a video's picture, in pixels from its top left. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** What ffmpeg said of a video it could not read as asked. */
export class FfmpegFailed extends Schema.TaggedError<FfmpegFailed>()("FfmpegFailed", {
  args: Schema.Array(Schema.String),
  said: Schema.String,
}) {
  override get message() {
    return `ffmpeg ${this.args.join(" ")}: ${this.said}`;
  }
}

const run = (args: readonly string[]) =>
  Effect.gen(function* () {
    const failed = (said: string) => new FfmpegFailed({ args, said });
    const handle = yield* ChildProcess.make(yield* ffmpeg, ["-nostdin", "-hide_banner", ...args], {
      stdin: "ignore",
    });
    // Both are read as they come: ffmpeg says a line for every frame, and waits to be heard.
    const [output, errors, code] = yield* Effect.all(
      [
        Stream.mkUint8Array(handle.stdout),
        Stream.mkString(Stream.decodeText(handle.stderr)),
        handle.exitCode,
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.mapError((error) => failed(error.message)));
    if (code !== 0) {
      return yield* failed(errors);
    }
    return { output, errors };
  }).pipe(
    Effect.scoped,
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(new FfmpegFailed({ args, said: error.message })),
    ),
  );

/** The sizes a video's frames have, as `800x600`, each once and in the order they come. */
export const frameSizes = (file: string) =>
  run(["-an", "-i", file, "-vf", "showinfo", "-f", "null", "-"]).pipe(
    Effect.map(({ errors }) => {
      const sizes = Array.from(errors.matchAll(/ s:(\d+x\d+)/gu), (frame) => frame[1]!);
      return Array.from(new Set(sizes));
    }),
  );

/** How large the patch around a point is that tells its colour. */
const PATCH = 4;

const named = (red: number, green: number, blue: number): string => {
  if (red > 150 && green < 100 && blue < 100) {
    return "red";
  }
  if (green > 150 && red < 100 && blue < 100) {
    return "green";
  }
  if (blue > 150 && red < 100 && green < 100) {
    return "blue";
  }
  if (red < 40 && green < 40 && blue < 40) {
    return "black";
  }
  return `${red},${green},${blue}`;
};

/**
 * The colour a video shows at a time: `red`, `green`, `blue` or `black` where it is nearly
 * that, and `r,g,b` otherwise. At a point it is the colour of a small patch there; without
 * one, of the whole picture.
 */
export const colourAt = (file: string, seconds: number, point?: Point) => {
  const whole = "scale=1:1";
  const looked =
    point === undefined ? whole : `crop=${PATCH}:${PATCH}:${point.x}:${point.y},${whole}`;
  return run([
    "-v",
    "error",
    "-ss",
    String(seconds),
    "-i",
    file,
    "-frames:v",
    "1",
    "-vf",
    looked,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-",
  ]).pipe(
    Effect.map(({ output }) =>
      output.length < 3 ? `no picture at ${seconds} s` : named(output[0]!, output[1]!, output[2]!),
    ),
  );
};
