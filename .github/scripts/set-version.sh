#!/usr/bin/env bash
# Writes one version wherever the tree keeps it, as a release's pull request does. A nightly
# has no such pull request, and is built from a tree this was run in.
set -euo pipefail

version="${1:?usage: set-version.sh VERSION}"

# The commit the tree is, which what is written below makes a tree with changes of: what is
# built from it says the commit beside the version, and the flake takes this for its own.
# Known to git, or a flake leaves it out.
if [[ ! -e .commit ]]; then
  git rev-parse HEAD > .commit
  git add --intent-to-add .commit
fi

# In place, as GNU's sed and macOS's alike take it: the programs are built on macOS too.
edit() {
  local file="$1"
  shift
  sed -E "$@" "$file" > "$file.new"
  mv "$file.new" "$file"
}

edit Cargo.toml '/^\[workspace\.package\]$/,/^\[/ s/^version = ".*"$/version = "'"$version"'"/'

for manifest in crates/*/Cargo.toml; do
  name="$(sed -n -E '/^\[package\]$/,/^\[/ s/^name = "(.*)"$/\1/p' "$manifest")"
  edit Cargo.lock '/^name = "'"$name"'"$/{
n
s/^version = ".*"$/version = "'"$version"'"/
}'
done

for manifest in packages/*/package.json apps/*/package.json extensions/*/package.json; do
  jq --arg version "$version" '.version = $version' "$manifest" > "$manifest.tmp"
  mv "$manifest.tmp" "$manifest"
done
