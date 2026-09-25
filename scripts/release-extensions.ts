// Builds each browser extension whose package.json sets `"aperture": { "releaseZip": true }`
// and writes its dist/ as <out-dir>/<extension>-<version>.zip, with the manifest version
// set to the release version.
//
// Usage: node scripts/release-extensions.ts <version> <out-dir>
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

// Browser extension manifests only accept one to four dot-separated integers.
const Arguments = Schema.Tuple([
  Schema.String.check(Schema.isPattern(/^\d+(\.\d+){0,3}$/)),
  Schema.String,
]);

const PackageManifest = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    aperture: Schema.optionalKey(Schema.Struct({ releaseZip: Schema.optionalKey(Schema.Boolean) })),
  }),
);

const ExtensionManifest = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));

class UsageError extends Data.TaggedError("UsageError")<{ readonly message: string }> {}

class CommandFailed extends Data.TaggedError("CommandFailed")<{ readonly message: string }> {}

const run = Effect.fn("run")(function* (cwd: string, command: string, ...args: string[]) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make(command, args, { cwd, stdout: "inherit", stderr: "inherit" }),
  );
  if (exitCode !== 0) {
    return yield* new CommandFailed({
      message: `${command} ${args.join(" ")} exited with ${exitCode}`,
    });
  }
});

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const [version, outArg] = yield* Schema.decodeUnknownEffect(Arguments)(
    process.argv.slice(2),
  ).pipe(
    Effect.mapError(
      () =>
        new UsageError({
          message: "usage: release-extensions.ts <version> <out-dir>, with a version such as 1.2.3",
        }),
    ),
  );
  const root = path.join(import.meta.dirname, "..");
  const outDir = path.resolve(outArg);
  yield* fs.makeDirectory(outDir, { recursive: true });

  for (const name of yield* fs.readDirectory(path.join(root, "extensions"))) {
    const dir = path.join(root, "extensions", name);
    const packagePath = path.join(dir, "package.json");
    if (!(yield* fs.exists(packagePath))) continue;
    const manifest = yield* fs
      .readFileString(packagePath)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(PackageManifest)));
    if (manifest.aperture?.releaseZip !== true) continue;

    yield* run(root, "pnpm", "--filter", manifest.name, "build");

    const extensionManifestPath = path.join(dir, "dist", "manifest.json");
    const extensionManifest = yield* fs
      .readFileString(extensionManifestPath)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ExtensionManifest)));
    yield* fs.writeFileString(
      extensionManifestPath,
      `${JSON.stringify({ ...extensionManifest, version }, null, 2)}\n`,
    );

    const zip = path.join(outDir, `${name}-${version}.zip`);
    yield* run(path.join(dir, "dist"), "zip", "-qr", zip, ".");
    yield* Console.log(`Wrote ${zip}`);
  }
});

NodeRuntime.runMain(
  program.pipe(
    Effect.tapError((error) => Console.error(error.message)),
    Effect.provide(NodeServices.layer),
  ),
  { disableErrorReporting: true },
);
