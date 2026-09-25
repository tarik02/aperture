#!/usr/bin/env node
// Fails when a workspace package.json names a dependency version directly: versions
// belong in the catalogs in pnpm-workspace.yaml (`catalog:` or `catalog:<name>`), and
// workspace packages are referenced with `workspace:`.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const sections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

const manifests = [
  "package.json",
  ...["apps", "extensions", "packages"].flatMap((dir) =>
    readdirSync(join(root, dir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name, "package.json")),
  ),
];

const problems = [];
for (const path of manifests) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(root, path), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  for (const section of sections) {
    for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
      if (!spec.startsWith("catalog:") && !spec.startsWith("workspace:")) {
        problems.push(`${path}: ${section}.${name} is "${spec}"; add it to a catalog instead`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
