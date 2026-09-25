// Finishes dist/styles.css for embedding: Tailwind's remaining theme variables move from
// :root onto .aperture-root, and the font files its relative url()s name are copied.
import { createRequire } from "node:module";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const stylesheet = "dist/styles.css";

class UnscopedStylesheet extends Data.TaggedError("UnscopedStylesheet")<{
  readonly message: string;
}> {}

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fontDir = path.dirname(
    createRequire(import.meta.url).resolve("@fontsource-variable/geist/index.css"),
  );

  const css = (yield* fs.readFileString(stylesheet)).replaceAll(
    /:root,\s*:host/g,
    ".aperture-root,:host",
  );
  if (/:root\b/.test(css)) {
    return yield* new UnscopedStylesheet({ message: `${stylesheet} still styles :root` });
  }
  yield* fs.writeFileString(stylesheet, css);

  const fonts = new Set(
    Array.from(css.matchAll(/url\(\.\/files\/([^)]+)\)/g), (match) => match[1]!),
  );
  yield* fs.makeDirectory("dist/files", { recursive: true });
  yield* Effect.forEach(
    fonts,
    (file) => fs.copyFile(path.join(fontDir, "files", file), path.join("dist/files", file)),
    { concurrency: "unbounded", discard: true },
  );
  yield* Console.log(`Scoped ${stylesheet} and copied ${fonts.size} font files`);
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
