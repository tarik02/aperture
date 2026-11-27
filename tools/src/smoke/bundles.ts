import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { SmokeFailed } from "../errors.ts";
import { Programs } from "../programs/service.ts";
import { loaded, navigate, targets, until } from "./session.ts";

/** How much of what the runner said is shown when the check fails. */
const SAID_LINES = 80;

/**
 * Unpacks a release's runner and browser where `aperture run` and the runner keep them,
 * starts a session with them where nothing of the machine's Nix is to be found, and asks it
 * from outside what the image is asked: the session answers, and a page loads over HTTPS.
 */
export const bundles = Effect.fn("smoke.bundles")(function* (runner: string, browser: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const programs = yield* Programs;
  const home = yield* Config.String("HOME");

  const file = path.basename(runner);
  const version = file
    .slice(file.startsWith("aperture-runner-") ? "aperture-runner-".length : 0)
    .replace(/-linux-(?!.*-linux-).*$/u, "");

  const work = yield* fs.makeTempDirectory();
  const cache = path.join(work, "cache");
  const data = path.join(work, "data");
  const unpacked = path.join(work, "runner");
  const chromium = path.join(cache, "aperture", "chromium", version);
  for (const [archive, into] of [
    [runner, unpacked],
    [browser, chromium],
  ] as const) {
    yield* fs.makeDirectory(into, { recursive: true });
    yield* programs.run("tar", [
      "--zstd",
      "--extract",
      "--file",
      path.resolve(archive),
      "--directory",
      into,
    ]);
  }

  let said: string[] = [];
  yield* Effect.gen(function* () {
    // A group of its own, which is how `aperture run` stops it. With no
    // `APERTURE_CHROMIUM` and no browser in `PATH`, the session's browser is the one
    // unpacked above.
    const handle = yield* programs.start(
      path.join(unpacked, "bin", "aperture-runner"),
      ["serve", "--data", data, "--listen", "127.0.0.1:0", "--feature", "mcp"],
      {
        env: { HOME: home, PATH: "/usr/bin:/bin", XDG_CACHE_HOME: cache },
        alone: true,
        endsWithin: 30,
      },
    );
    yield* handle.all.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        Effect.sync(() => {
          said = [...said.slice(1 - SAID_LINES), line];
        }),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );
    const alive = handle.isRunning.pipe(
      Effect.orElseSucceed(() => false),
      Effect.flatMap((running) =>
        running ? Effect.void : Effect.fail(new SmokeFailed({ reason: "the runner ended" })),
      ),
    );

    const written = (name: string) =>
      fs.readFileString(path.join(data, name)).pipe(Effect.map((text) => text.trim()));
    yield* until(
      "the runner told no address and token",
      120,
      Effect.all([written("address"), written("token")]).pipe(
        Effect.map(([address, token]) => address !== "" && token !== ""),
      ),
      alive,
    );
    const url = `http://${yield* written("address")}`;
    const token = yield* written("token");

    yield* until(
      "the session told of no tab",
      120,
      targets(url, token).pipe(Effect.map((tabs) => tabs.length > 0)),
      alive,
    );
    yield* navigate(url, token);
    yield* until(
      "the session did not load the page",
      60,
      targets(url, token).pipe(Effect.map(loaded)),
      alive,
    );
  }).pipe(
    Effect.tapError(() => Console.error(said.join("\n"))),
    Effect.scoped,
  );
  yield* Console.log("the session answers, and a page loaded over HTTPS");
});
