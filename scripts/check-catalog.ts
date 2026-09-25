// Fails when a workspace package.json names a dependency version directly: versions
// belong in the catalogs in pnpm-workspace.yaml (`catalog:` or `catalog:<name>`), and
// workspace packages are referenced with `workspace:`.
//
// Usage: node scripts/check-catalog.ts
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const Dependencies = Schema.optionalKey(Schema.Record(Schema.String, Schema.String));

const Manifest = Schema.fromJsonString(
  Schema.Struct({
    dependencies: Dependencies,
    devDependencies: Dependencies,
    optionalDependencies: Dependencies,
    peerDependencies: Dependencies,
  }),
);

class CatalogViolations extends Data.TaggedError("CatalogViolations")<{
  readonly message: string;
}> {}

const workspaceManifests = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(import.meta.dirname, "..");
  const nested = yield* Effect.forEach(["apps", "extensions", "packages"], (group) =>
    fs
      .readDirectory(path.join(root, group))
      .pipe(Effect.map((names) => names.map((name) => path.join(group, name, "package.json")))),
  );
  const candidates = ["package.json", ...nested.flat()];
  const present = yield* Effect.filter(candidates, (manifest) =>
    fs.exists(path.join(root, manifest)),
  );
  return { root, manifests: present };
});

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { root, manifests } = yield* workspaceManifests;

  const problems: string[] = [];
  for (const manifest of manifests) {
    const sections = yield* fs
      .readFileString(path.join(root, manifest))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Manifest)));
    for (const [section, dependencies] of Object.entries(sections)) {
      for (const [name, spec] of Object.entries(dependencies ?? {})) {
        if (!spec.startsWith("catalog:") && !spec.startsWith("workspace:")) {
          problems.push(
            `${manifest}: ${section}.${name} is "${spec}"; add it to a catalog instead`,
          );
        }
      }
    }
  }

  if (problems.length > 0) {
    return yield* new CatalogViolations({ message: problems.join("\n") });
  }
});

NodeRuntime.runMain(
  program.pipe(
    Effect.tapError((error) => Console.error(error.message)),
    Effect.provide(NodeServices.layer),
  ),
  { disableErrorReporting: true },
);
