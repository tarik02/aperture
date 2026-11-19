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

// Keyframe, cascade layer and registered property names are document-global, so a host page
// using Tailwind or tw-animate-css would share (and could reorder or override) them.
const namespaceGlobals = (css: string): string => {
  const keyframes = Array.from(css.matchAll(/@keyframes\s+([\w-]+)/g), ([, name]) => name);
  const keyframeName = new RegExp(`(?<![\\w-])(${keyframes.join("|")})(?![\\w-])`, "g");
  return css
    .replaceAll("--tw-", "--aperture-tw-")
    .replaceAll(/@keyframes\s+([\w-]+)/g, "@keyframes aperture-$1")
    .replaceAll(
      /(animation(?:-name)?:)([^;}]*)/g,
      (_, property: string, value: string) =>
        property + value.replaceAll(keyframeName, "aperture-$1"),
    )
    .replaceAll(
      /@layer\s+([\w-]+(?:\s*,\s*[\w-]+)*)/g,
      (_, names: string) =>
        `@layer ${names
          .split(",")
          .map((name) => `aperture-${name.trim()}`)
          .join(",")}`,
    );
};

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const css = namespaceGlobals(
    (yield* fs.readFileString(stylesheet)).replaceAll(/:root,\s*:host/g, ".aperture-root,:host"),
  );
  if (/:root\b/.test(css)) {
    return yield* new UnscopedStylesheet({ message: `${stylesheet} still styles :root` });
  }
  yield* fs.writeFileString(stylesheet, css);
  yield* Console.log(`Scoped ${stylesheet}`);
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
