import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Resvg } from "@resvg/resvg-js";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

// Chromium does not accept SVG extension icons, so every size is rendered from public/icon.svg.
const sizes = [16, 32, 48, 128];

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const publicDir = path.join(import.meta.dirname, "..", "public");
  const source = yield* fs.readFileString(path.join(publicDir, "icon.svg"));

  yield* Effect.forEach(
    sizes,
    (size) => {
      const icon = new Resvg(source, { fitTo: { mode: "width", value: size } });
      return fs.writeFile(path.join(publicDir, `icon-${size}.png`), icon.render().asPng());
    },
    { concurrency: "unbounded", discard: true },
  );
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
