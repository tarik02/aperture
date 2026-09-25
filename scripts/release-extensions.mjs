#!/usr/bin/env node
// Builds each browser extension whose package.json sets `"aperture": { "releaseZip": true }`
// and zips its dist/ as <extension>-<version>.zip, with the manifest version set to the
// release version. Prints the zip paths, one per line, for the release upload.
//
// Usage: node scripts/release-extensions.mjs <version> <out-dir>

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [version, outArg] = process.argv.slice(2);
if (!version || !outArg || !/^\d+(\.\d+){0,3}$/.test(version)) {
  throw new Error(
    "usage: release-extensions.mjs <version> <out-dir>, with a numeric version such as 1.2.3",
  );
}
const root = new URL("..", import.meta.url).pathname;
const outDir = resolve(outArg);
mkdirSync(outDir, { recursive: true });

for (const entry of readdirSync(join(root, "extensions"), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = join(root, "extensions", entry.name);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  if (manifest.aperture?.releaseZip !== true) continue;

  // Tool output goes to stderr; stdout carries only the zip paths.
  execFileSync("pnpm", ["--filter", manifest.name, "build"], {
    cwd: root,
    stdio: ["ignore", 2, 2],
  });
  const extensionManifestPath = join(dir, "dist", "manifest.json");
  const extensionManifest = JSON.parse(readFileSync(extensionManifestPath, "utf8"));
  writeFileSync(
    extensionManifestPath,
    `${JSON.stringify({ ...extensionManifest, version }, null, 2)}\n`,
  );

  const zip = join(outDir, `${entry.name}-${version}.zip`);
  execFileSync("zip", ["-qr", zip, "."], { cwd: join(dir, "dist"), stdio: ["ignore", 2, 2] });
  console.log(zip);
}
