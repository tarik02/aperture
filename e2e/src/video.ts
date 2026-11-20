import { execFile } from "node:child_process";
import * as Effect from "effect/Effect";
import { ffmpeg } from "./programs.ts";

/** How much ffmpeg may say of one video: a line for every frame. */
const SAID_MOST = 64 * 1024 * 1024;

/** A place in a video's picture, in pixels from its top left. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

interface Said {
  readonly output: Buffer;
  readonly errors: string;
}

const run = (args: readonly string[]): Effect.Effect<Said> =>
  Effect.promise(
    () =>
      new Promise<Said>((said, failed) => {
        execFile(
          ffmpeg(),
          ["-nostdin", "-hide_banner", ...args],
          { encoding: "buffer", maxBuffer: SAID_MOST },
          (error, output, errors) => {
            if (error === null) {
              said({ output, errors: errors.toString() });
              return;
            }
            failed(new Error(`ffmpeg ${args.join(" ")}: ${errors.toString()}`));
          },
        );
      }),
  );

/** The sizes a video's frames have, as `800x600`, each once and in the order they come. */
export const frameSizes = (file: string): Effect.Effect<readonly string[]> =>
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
export const colourAt = (file: string, seconds: number, point?: Point): Effect.Effect<string> => {
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
