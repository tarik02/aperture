import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

const stylesheet = "dist/styles.css";

class UnscopedStylesheet extends Data.TaggedError("UnscopedStylesheet")<{
  readonly message: string;
}> {}

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const css = (yield* fs.readFileString(stylesheet)).replaceAll(
    /:root,\s*:host/g,
    ".aperture-root,:host",
  );
  if (/:root\b/.test(css)) {
    return yield* new UnscopedStylesheet({ message: `${stylesheet} still styles :root` });
  }
  yield* fs.writeFileString(stylesheet, css);
  yield* Console.log(`Scoped ${stylesheet}`);
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
