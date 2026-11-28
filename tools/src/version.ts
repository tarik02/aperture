import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Actions } from "./actions/service.ts";
import { TreeUnexpected } from "./errors.ts";
import { GitHub } from "./github/service.ts";
import { Programs } from "./programs/service.ts";

/** A version as a release or a nightly is built as: `1.0.0`, `1.0.0-beta.2`, `0.0.0-nightly.7.abc`. */
export const Version = Schema.String.check(
  Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u),
);

/** A manifest of the workspace, of which only the version is written. */
const Manifest = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));

/**
 * A file's lines, each with what ends it, so that one is changed and the file is written
 * back as it was otherwise: a checkout on Windows ends its lines with CR LF.
 */
const linesOf = (text: string) =>
  text.split("\n").map((line, index, all) => {
    const last = index === all.length - 1;
    const crlf = line.endsWith("\r");
    return {
      text: crlf ? line.slice(0, -1) : line,
      end: last ? "" : crlf ? "\r\n" : "\n",
    };
  });
type Line = ReturnType<typeof linesOf>[number];
const joined = (lines: readonly Line[]) => lines.map((line) => line.text + line.end).join("");

const SECTION = /^\[/u;
const VERSION = /^version = "(.*)"$/u;
const NAME = /^name = "(.*)"$/u;

/** The lines of a TOML section, as far as the next one: `[package]`, `[workspace.package]`. */
const section = (lines: readonly Line[], header: string) => {
  const start = lines.findIndex((line) => line.text === header);
  if (start === -1) {
    return [];
  }
  const after = lines.slice(start + 1).findIndex((line) => SECTION.test(line.text));
  return lines.slice(start + 1, after === -1 ? lines.length : start + 1 + after);
};

const CARGO = "Cargo.toml";

/** The version the tree's programs are built as: the workspace's, in `Cargo.toml`. */
export const workspaceVersion = Effect.fn("workspaceVersion")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const lines = linesOf(yield* fs.readFileString(CARGO));
  for (const line of section(lines, "[workspace.package]")) {
    const found = VERSION.exec(line.text);
    if (found !== null) {
      return found[1] ?? "";
    }
  }
  return yield* new TreeUnexpected({ file: CARGO, reason: "[workspace.package] has no version" });
});

/** The manifests of a directory's members, `crates/*\/Cargo.toml` and the like. */
const members = Effect.fn("members")(function* (directory: string, manifest: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(directory))) {
    return [];
  }
  const found: string[] = [];
  for (const name of (yield* fs.readDirectory(directory)).toSorted()) {
    const file = path.join(directory, name, manifest);
    if (yield* fs.exists(file)) {
      found.push(file);
    }
  }
  return found;
});

/**
 * Writes one version wherever the tree keeps it, as a release's pull request does. A
 * nightly has no such pull request, and is built from a tree this was run in.
 */
export const setVersion = Effect.fn("setVersion")(function* (version: string) {
  const fs = yield* FileSystem.FileSystem;
  const programs = yield* Programs;

  // The commit the tree is, which what is written below makes a tree with changes of: what
  // is built from it says the commit beside the version, and the flake takes this for its
  // own. Known to git, or a flake leaves it out.
  if (!(yield* fs.exists(".commit"))) {
    const commit = yield* programs.read("git", ["rev-parse", "HEAD"]);
    yield* fs.writeFileString(".commit", commit);
    yield* programs.run("git", ["add", "--intent-to-add", ".commit"]);
  }

  const cargo = linesOf(yield* fs.readFileString(CARGO));
  for (const line of section(cargo, "[workspace.package]")) {
    if (VERSION.test(line.text)) {
      line.text = `version = "${version}"`;
    }
  }
  yield* fs.writeFileString(CARGO, joined(cargo));

  const lock = linesOf(yield* fs.readFileString("Cargo.lock"));
  for (const manifest of yield* members("crates", "Cargo.toml")) {
    const crate = section(linesOf(yield* fs.readFileString(manifest)), "[package]")
      .map((line) => NAME.exec(line.text)?.[1])
      .find((name) => name !== undefined);
    if (crate === undefined) {
      return yield* new TreeUnexpected({ file: manifest, reason: "[package] has no name" });
    }
    lock.forEach((line, index) => {
      const next = lock[index + 1];
      if (line.text === `name = "${crate}"` && next !== undefined && VERSION.test(next.text)) {
        next.text = `version = "${version}"`;
      }
    });
  }
  yield* fs.writeFileString("Cargo.lock", joined(lock));

  for (const directory of ["packages", "apps", "extensions"]) {
    for (const manifest of yield* members(directory, "package.json")) {
      const read = yield* Schema.decodeUnknownEffect(Manifest)(
        yield* fs.readFileString(manifest),
      ).pipe(
        Effect.mapError((error) => new TreeUnexpected({ file: manifest, reason: error.message })),
      );
      yield* fs.writeFileString(manifest, `${JSON.stringify({ ...read, version }, null, 2)}\n`);
    }
  }
  yield* Console.log(`the tree is at ${version}`);
});

/**
 * A nightly's version, of the commit and the run that build it, and its release: a
 * prerelease that is never the latest. Its version and the commit's short hash are the
 * step's outputs. Without `create`, the release is told and not made.
 */
export const nightly = Effect.fn("nightly")(function* (create: boolean) {
  const actions = yield* Actions;
  const github = yield* GitHub;
  const commit = yield* Config.String("GITHUB_SHA");
  const run = yield* Config.Int("GITHUB_RUN_NUMBER");
  const short = commit.slice(0, 12);
  const version = yield* Schema.decodeUnknownEffect(Version)(`0.0.0-nightly.${run}.${short}`);
  const release = {
    tag: `v${version}`,
    target: commit,
    title: `v${version}`,
    notes: `Built from ${commit}.`,
    prerelease: true,
    latest: false,
  };
  if (create) {
    yield* github.createRelease(release);
  } else {
    yield* Console.log(`the release would be ${JSON.stringify(release)}`);
  }
  yield* actions.output("version", version);
  yield* actions.output("short_sha", short);
});
