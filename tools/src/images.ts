import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Actions } from "./actions/service.ts";
import { Missing, ProgramFailed } from "./errors.ts";
import { Programs } from "./programs/service.ts";

const RepoDigests = Schema.fromJsonString(Schema.Array(Schema.String));
const Manifest = Schema.fromJsonString(Schema.Struct({ digest: Schema.String }));

const unreadable = (program: string) => (error: Schema.SchemaError) =>
  new ProgramFailed({ program, reason: `what it said is not as expected: ${error.message}` });

export interface Pushed {
  /** The image's archive, as the flake's image streams it. */
  readonly archive: string;
  /** What the archive names the image, `aperture-session`; it is tagged as the version. */
  readonly name: string;
  /** Where it goes, `ghcr.io/owner/aperture-session`. */
  readonly repository: string;
  readonly version: string;
  readonly arch: string;
  /** Whether cosign signs what was pushed. */
  readonly sign: boolean;
}

/**
 * Pushes the image of an architecture as `<version>-<arch>`, and gives the digest the
 * registry has it by.
 */
export const push = Effect.fn("push")(function* (image: Pushed) {
  const programs = yield* Programs;
  const tag = `${image.repository}:${image.version}-${image.arch}`;
  yield* programs.run("docker", ["load", "--input", image.archive]);
  yield* programs.run("docker", ["tag", `${image.name}:${image.version}`, tag]);
  yield* programs.run("docker", ["push", tag]);
  const said = yield* programs.read("docker", [
    "image",
    "inspect",
    tag,
    "--format",
    "{{json .RepoDigests}}",
  ]);
  const digests = yield* Schema.decodeUnknownEffect(RepoDigests)(said).pipe(
    Effect.mapError(unreadable("docker image inspect")),
  );
  const pushed = digests.find((digest) => digest.startsWith(`${image.repository}@`));
  if (pushed === undefined) {
    return yield* new Missing({ what: `the digest ${image.repository} has ${tag} by` });
  }
  if (image.sign) {
    yield* programs.run("cosign", ["sign", "--yes", pushed]);
  }
  return pushed.slice(pushed.indexOf("@") + 1);
});

export interface Published {
  readonly repository: string;
  readonly version: string;
  /** Each a tag of the manifest; the first is the one it is read back by. */
  readonly tags: readonly string[];
  readonly sign: boolean;
}

const ARCHES = ["amd64", "arm64"];

/**
 * Publishes the manifest of both architectures' images under each tag, and gives its digest.
 */
export const manifest = Effect.fn("manifest")(function* (published: Published) {
  const programs = yield* Programs;
  const [first] = published.tags;
  if (first === undefined) {
    return yield* new Missing({ what: "a tag of the manifest" });
  }
  yield* programs.run("docker", [
    "buildx",
    "imagetools",
    "create",
    ...published.tags.flatMap((tag) => ["--tag", `${published.repository}:${tag}`]),
    ...ARCHES.map((arch) => `${published.repository}:${published.version}-${arch}`),
  ]);
  const named = `${published.repository}:${first}`;
  yield* programs.run("docker", ["buildx", "imagetools", "inspect", named]);
  const said = yield* programs.read("docker", [
    "buildx",
    "imagetools",
    "inspect",
    named,
    "--format",
    "{{json .Manifest}}",
  ]);
  const { digest } = yield* Schema.decodeUnknownEffect(Manifest)(said).pipe(
    Effect.mapError(unreadable("docker buildx imagetools inspect")),
  );
  if (published.sign) {
    yield* programs.run("cosign", ["sign", "--yes", `${published.repository}@${digest}`]);
  }
  return digest;
});

/** The tags of a list as a workflow gives it, a line each; blank lines are none. */
export const tagsOf = (lines: string) => lines.split(/\r?\n/u).filter((tag) => tag !== "");

/** The store paths of the flake's packages, without building them, as a step's output. */
export const outPaths = Effect.fn("outPaths")(function* (
  packages: readonly string[],
  output: string,
) {
  const programs = yield* Programs;
  const actions = yield* Actions;
  const paths: string[] = [];
  for (const name of packages) {
    paths.push(yield* programs.read("nix", ["eval", "--raw", `.#${name}.outPath`]));
  }
  yield* Console.log(paths.join("\n"));
  yield* actions.output(output, paths.join("\n"));
});
