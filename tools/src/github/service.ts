import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { ProgramFailed } from "../errors.ts";

export interface NewRelease {
  readonly tag: string;
  /** The commit the tag is made at. */
  readonly target: string;
  readonly title: string;
  readonly notes: string;
  readonly prerelease: boolean;
  /** Whether it is marked the repository's latest release. */
  readonly latest: boolean;
}

/**
 * The repository's releases, as `gh` reaches them: of `GH_REPO`, with the token of
 * `GH_TOKEN`.
 */
export interface GitHubShape {
  readonly createRelease: (release: NewRelease) => Effect.Effect<void, ProgramFailed>;
  /** Puts files on a release, each in place of one of its name that is there already. */
  readonly upload: (
    tag: string,
    directory: string,
    names: readonly string[],
  ) => Effect.Effect<void, ProgramFailed>;
}

export class GitHub extends Context.Service<GitHub, GitHubShape>()(
  "@aperture-browser/tools/GitHub",
) {}
