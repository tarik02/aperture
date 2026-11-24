#!/usr/bin/env bash
# Writes one version wherever the tree keeps it, as a release's pull request does. A nightly
# has no such pull request, and is built from a tree this was run in.
set -euo pipefail

version="${1:?usage: set-version.sh VERSION}"

sed -i -E '/^\[workspace\.package\]$/,/^\[/ s/^version = ".*"$/version = "'"$version"'"/' Cargo.toml

for manifest in crates/*/Cargo.toml; do
  name="$(sed -n -E '/^\[package\]$/,/^\[/ s/^name = "(.*)"$/\1/p' "$manifest")"
  sed -i -E '/^name = "'"$name"'"$/{n;s/^version = ".*"$/version = "'"$version"'"/}' Cargo.lock
done

for manifest in packages/*/package.json apps/*/package.json extensions/*/package.json; do
  jq --arg version "$version" '.version = $version' "$manifest" > "$manifest.tmp"
  mv "$manifest.tmp" "$manifest"
done
