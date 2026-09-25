import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Argument from "effect/unstable/cli/Argument";
import * as CliError from "effect/unstable/cli/CliError";
import * as Command from "effect/unstable/cli/Command";

const Json = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));

const Manifest = Schema.Struct({
  name: Schema.String,
  private: Schema.optionalKey(Schema.Boolean),
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

const setSnapshotVersion = Command.make(
  "set-snapshot-version",
  {
    version: Argument.String("version").pipe(
      Argument.withSchema(Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/))),
    ),
  },
  Effect.fn(function* ({ version }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const packages = path.join(import.meta.dirname, "..", "packages");

    for (const name of yield* fs.readDirectory(packages)) {
      const manifestPath = path.join(packages, name, "package.json");
      if (!(yield* fs.exists(manifestPath))) continue;
      const raw = yield* fs
        .readFileString(manifestPath)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Json)));
      const manifest = yield* Schema.decodeUnknownEffect(Manifest)(raw);
      if (manifest.private === true) continue;

      const dependencies =
        manifest.dependencies &&
        Object.fromEntries(
          Object.entries(manifest.dependencies).map(([dependency, spec]) => [
            dependency,
            spec.startsWith("workspace:") ? "workspace:*" : spec,
          ]),
        );
      yield* fs.writeFileString(
        manifestPath,
        `${JSON.stringify({ ...raw, version, ...(dependencies && { dependencies }) }, null, 2)}\n`,
      );
      yield* Console.log(`${manifest.name}@${version}`);
    }
  }),
);

NodeRuntime.runMain(
  Command.run(setSnapshotVersion, { version: "0.0.0" }).pipe(
    Effect.tapError((error) =>
      CliError.isCliError(error) ? Effect.void : Console.error(error.message),
    ),
    Effect.provide(NodeServices.layer),
  ),
  { disableErrorReporting: true },
);
