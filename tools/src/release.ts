import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Missing, TreeUnexpected } from "./errors.ts";
import { GitHub } from "./github/service.ts";
import { Programs } from "./programs/service.ts";
import { workspaceVersion } from "./version.ts";

/** The systems the `aperture` program is built for, by the target cargo builds it for. */
export const CLI_TARGETS = {
  "x86_64-unknown-linux-musl": { os: "linux", arch: "amd64" },
  "aarch64-unknown-linux-musl": { os: "linux", arch: "arm64" },
  "aarch64-apple-darwin": { os: "darwin", arch: "arm64" },
  "x86_64-apple-darwin": { os: "darwin", arch: "amd64" },
  "x86_64-pc-windows-msvc": { os: "windows", arch: "amd64" },
} as const;
export type CliTarget = keyof typeof CLI_TARGETS;

/**
 * Builds the `aperture` program for a target with nothing it loads but the system's, and
 * puts it in the directory under the name a release has it by.
 */
export const cli = Effect.fn("cli")(function* (target: CliTarget, directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const programs = yield* Programs;
  const { os, arch } = CLI_TARGETS[target];
  yield* programs.run("cargo", [
    "build",
    "--release",
    "--locked",
    "--package",
    "aperture-cli",
    "--target",
    target,
  ]);
  const version = yield* workspaceVersion();
  const exe = os === "windows" ? ".exe" : "";
  const file = path.resolve(directory, `aperture-${version}-${os}-${arch}${exe}`);
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.copyFile(path.join("target", target, "release", `aperture${exe}`), file);
  // An Intel program does not run on the Mac it is built on.
  if (target !== "x86_64-apple-darwin") {
    yield* programs.run(file, ["--version"]);
  }
});

/** What `aperture run` downloads: the runner, and the browser it starts sessions with. */
const BUNDLES = ["runner-bundle", "chromium-bundle"];

/** Builds the runner's and the browser's files, and puts them in the directory by their names. */
export const bundles = Effect.fn("bundles")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const programs = yield* Programs;
  yield* fs.makeDirectory(directory, { recursive: true });
  for (const bundle of BUNDLES) {
    yield* programs.run("nix", [
      "build",
      `.#${bundle}`,
      "--out-link",
      bundle,
      "--print-build-logs",
    ]);
    const name = yield* programs.read("nix", ["eval", "--raw", `.#${bundle}.name`]);
    const file = path.join(directory, name);
    yield* fs.copyFile(bundle, file);
    const info = yield* fs.stat(file);
    yield* Console.log(`${file}: ${info.size} bytes`);
  }
});

const Companion = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));
const COMPANION = "extensions/aperture-companion";

/**
 * Builds the extension for a browser of someone's own, and zips it as a release has it to
 * load unpacked, by the version it was written as.
 */
export const companion = Effect.fn("companion")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const programs = yield* Programs;
  const manifest = path.join(COMPANION, "package.json");
  const { version } = yield* Schema.decodeUnknownEffect(Companion)(
    yield* fs.readFileString(manifest),
  ).pipe(Effect.mapError((error) => new TreeUnexpected({ file: manifest, reason: error.message })));
  yield* programs.run("pnpm", ["--filter", "@aperture-browser/companion", "build"]);
  const zip = path.resolve(`aperture-companion-${version}.zip`);
  yield* programs.run("zip", ["--quiet", "--recurse-paths", zip, "."], {
    cwd: path.join(COMPANION, "dist"),
  });
  yield* Console.log(zip);
});

const SUMS = "SHA256SUMS";

/**
 * The sums of a directory's files as `sha256sum` writes them, written beside them where
 * `write` is set, and the names of all that a release gets: the sums' file with them.
 */
export const sums = Effect.fn("sums")(function* (directory: string, write: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const names = (yield* fs.readDirectory(directory))
    .filter((name) => !name.startsWith(".") && name !== SUMS)
    .toSorted();
  if (names.length === 0) {
    return yield* new Missing({ what: `a file in ${directory}` });
  }
  let written = "";
  for (const name of names) {
    const digest = yield* crypto.digest("SHA-256", yield* fs.readFile(path.join(directory, name)));
    written += `${Hex.encode(digest)}  ${name}\n`;
  }
  if (write) {
    yield* fs.writeFileString(path.join(directory, SUMS), written);
  }
  yield* Console.log(written.trimEnd());
  return [...names, SUMS].toSorted();
});

/**
 * Puts a directory's files on a release with their sums, each in place of one of its name.
 * Without `upload`, the sums and what would be put are told, and nothing is written.
 */
export const publish = Effect.fn("publish")(function* (
  directory: string,
  tag: string,
  upload: boolean,
) {
  const github = yield* GitHub;
  const names = yield* sums(directory, upload);
  if (upload) {
    yield* github.upload(tag, directory, names);
  } else {
    yield* Console.log(`${tag} would get ${names.join(", ")}`);
  }
});
