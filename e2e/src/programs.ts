import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** A variable of the environment the checks need and were not given. */
export class NotTold extends Schema.TaggedError<NotTold>()("NotTold", {
  variable: Schema.String,
}) {
  override get message() {
    return `${this.variable} is not set; the Nix dev shell sets it`;
  }
}

const told = (variable: string) =>
  Config.NonEmptyString(variable).pipe(Effect.mapError(() => new NotTold({ variable })));

/** Where the programs under test are; a debug build of this checkout unless told otherwise. */
const programs = Effect.gen(function* () {
  const path = yield* Path.Path;
  const built = yield* path.fromFileUrl(new URL("../../target/debug", import.meta.url));
  return yield* Config.String("APERTURE_BIN").pipe(Config.withDefault(built));
});

/** Where one of the programs under test is: `aperture-runner`, `aperture-executor`, … */
export const program = (name: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(yield* programs, name);
  });

/** The browser the checks watch sessions with, which is the one sessions run. */
export const chromium = told("APERTURE_CHROMIUM");

export const ffmpeg = told("APERTURE_FFMPEG");
