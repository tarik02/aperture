#!/usr/bin/env node
// Publishes every non-private package under packages/, dependencies first. Versions that
// are already on the registry are skipped, so a failed run can be retried.
//
// Each package is packed with pnpm, which turns workspace: and catalog: ranges into real
// versions and applies publishConfig, and the tarball is published with npm. In GitHub
// Actions npm authenticates with trusted publishing (OIDC) and adds provenance.
//
// Usage: node scripts/publish-npm.mjs [--dry-run]

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dryRun = process.argv.includes("--dry-run");
const root = new URL("..", import.meta.url).pathname;

const packages = readdirSync(join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const dir = join(root, "packages", entry.name);
    return { dir, manifest: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) };
  })
  .filter(({ manifest }) => !manifest.private);

const names = new Set(packages.map(({ manifest }) => manifest.name));
const internalDependencies = ({ manifest }) =>
  Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }).filter((name) =>
    names.has(name),
  );

const ordered = [];
const visit = (pkg, path = []) => {
  if (ordered.includes(pkg)) return;
  if (path.includes(pkg))
    throw new Error(`dependency cycle: ${[...path, pkg].map((p) => p.manifest.name).join(" -> ")}`);
  for (const name of internalDependencies(pkg)) {
    visit(
      packages.find(({ manifest }) => manifest.name === name),
      [...path, pkg],
    );
  }
  ordered.push(pkg);
};
packages.forEach((pkg) => visit(pkg));

const outDir = mkdtempSync(join(tmpdir(), "aperture-npm-"));
const published = (name, version) => {
  try {
    execFileSync("npm", ["view", `${name}@${version}`, "version"], { cwd: outDir, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
};

for (const { dir, manifest } of ordered) {
  const { name, version } = manifest;
  if (published(name, version)) {
    console.log(`${name}@${version} is already published`);
    continue;
  }
  const before = new Set(readdirSync(outDir));
  execFileSync("pnpm", ["pack", "--pack-destination", outDir], { cwd: dir, stdio: "inherit" });
  const tarball = readdirSync(outDir).find((file) => !before.has(file));
  const args = ["publish", join(outDir, tarball), "--access", "public"];
  if (process.env.GITHUB_ACTIONS) args.push("--provenance");
  if (dryRun) args.push("--dry-run");
  console.log(`Publishing ${name}@${version}`);
  // Outside the workspace, whose devEngines only allow pnpm.
  execFileSync("npm", args, { cwd: outDir, stdio: "inherit" });
}
