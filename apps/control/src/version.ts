import * as Option from "effect/Option";
import manifest from "../package.json" with { type: "json" };

/** The version of Aperture this is, as it is released. */
export const version = manifest.version;

/**
 * The version with the commit it was built from as build metadata, as the programs of a
 * node say theirs: `1.0.0+86bc786e`, `1.0.0+86bc786e-dirty`.
 */
export const fullVersion = (commit: Option.Option<string>) =>
  Option.match(commit, {
    onNone: () => version,
    onSome: (sha) => `${version}+${sha.slice(0, 8)}${sha.endsWith("-dirty") ? "-dirty" : ""}`,
  });
