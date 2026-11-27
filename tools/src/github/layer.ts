import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Programs } from "../programs/service.ts";
import { GitHub, type NewRelease } from "./service.ts";

export const makeGitHub = Effect.fn("GitHub.make")(function* () {
  const programs = yield* Programs;

  const createRelease = Effect.fn("GitHub.createRelease")(function* (release: NewRelease) {
    yield* programs.run("gh", [
      "release",
      "create",
      release.tag,
      "--target",
      release.target,
      "--title",
      release.title,
      "--notes",
      release.notes,
      ...(release.prerelease ? ["--prerelease"] : []),
      `--latest=${release.latest}`,
    ]);
  });

  const upload = Effect.fn("GitHub.upload")(function* (
    tag: string,
    directory: string,
    names: readonly string[],
  ) {
    yield* programs.run(
      "gh",
      ["release", "upload", tag, ...names.map((name) => `./${name}`), "--clobber"],
      { cwd: directory },
    );
  });

  return GitHub.of({ createRelease, upload });
});

export const layer = Layer.effect(GitHub, makeGitHub());
