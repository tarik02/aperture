import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Missing, SmokeFailed } from "../errors.ts";
import { Programs } from "../programs/service.ts";
import { answer, loaded, navigate, targets, until } from "./session.ts";

const NAME = "aperture-smoke";

/** The image's name as `docker load` or `podman load` tells it, of the last it loaded. */
export const loadedImage = (said: string, archive: string) => {
  const image = said
    .split("\n")
    .flatMap((line) => (line.startsWith("Loaded image: ") ? [line.slice(14).trim()] : []))
    .at(-1);
  return image === undefined
    ? Effect.fail(new Missing({ what: `an image in ${archive}` }))
    : Effect.succeed(image);
};

/**
 * Starts the session's image as docs/install.md tells its users to, and asks it from
 * outside what they would: the session answers, the workbench is served, and a page loads
 * over HTTPS.
 */
export const image = Effect.fn("smoke.image")(function* (archive: string, port: number) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const programs = yield* Programs;
  const url = `http://127.0.0.1:${port}`;

  const image = yield* loadedImage(
    yield* programs.read("podman", ["load", "--input", archive]),
    archive,
  );

  const removed = Effect.ignore(
    programs.run("podman", ["rm", "--force", "--volumes", NAME], { quiet: true }),
  ).pipe(
    Effect.andThen(
      Effect.ignore(programs.run("podman", ["volume", "rm", "--force", NAME], { quiet: true })),
    ),
  );
  const shown = programs.read("podman", ["logs", NAME], { both: true }).pipe(
    Effect.flatMap((said) => Console.error(said.trimEnd().split("\n").slice(-60).join("\n"))),
    Effect.ignore,
  );

  yield* Effect.gen(function* () {
    yield* programs.read("podman", [
      "run",
      "--detach",
      "--name",
      NAME,
      "--security-opt",
      "unmask=ALL",
      "-v",
      `${NAME}:/data`,
      "-p",
      `127.0.0.1:${port}:7900`,
      "-e",
      "APERTURE_FEATURES=sound,uploads,downloads,recordings,clipboard,mcp,cdp",
      image,
    ]);

    const alive = programs.read("podman", ["inspect", "--format", "{{.State.Running}}", NAME]).pipe(
      Effect.orElseSucceed(() => ""),
      Effect.flatMap((running) =>
        running.trim() === "true"
          ? Effect.void
          : Effect.fail(new SmokeFailed({ reason: "the container ended" })),
      ),
    );

    // The image has no shell to read the token with.
    const copied = path.join(yield* fs.makeTempDirectory(), "token");
    let token = "";
    const read = programs
      .run("podman", ["cp", `${NAME}:/data/token`, copied], { quiet: true })
      .pipe(
        Effect.andThen(fs.readFileString(copied)),
        Effect.tap((read) =>
          Effect.sync(() => {
            token = read.trim();
          }),
        ),
      );

    yield* until(
      "the session told of no tab",
      120,
      read.pipe(
        Effect.andThen(() => (token === "" ? Effect.succeed([]) : targets(url, token))),
        Effect.map((tabs) => tabs.length > 0),
      ),
      alive,
    );

    const workbench = yield* answer(
      `${url}/?token=${encodeURIComponent(token)}`,
      undefined,
      10,
    ).pipe(
      Effect.mapError((error) => new SmokeFailed({ reason: `the workbench: ${error.message}` })),
    );
    if (!/<!doctype html/iu.test(workbench)) {
      return yield* new SmokeFailed({ reason: "the workbench is not a page" });
    }

    yield* navigate(url, token);
    yield* until(
      "the session did not load the page",
      60,
      targets(url, token).pipe(Effect.map(loaded)),
      alive,
    );
  }).pipe(
    Effect.tapError(() => shown),
    Effect.ensuring(removed),
  );

  yield* Console.log("the session answers, and a page loaded over HTTPS");
});
