import { readFileSync } from "node:fs";
import { build } from "esbuild";

const codecLicense = readFileSync(
  new URL("../../packages/browser-state/LICENSE", import.meta.url),
  "utf8",
);
const browserPayloads = [
  ["target", "ApertureTargetRestore"],
  ["session-storage", "ApertureSessionStorageRestore"],
  ["origin-storage", "ApertureOriginStorageRestore"],
];

for (const [name, globalName] of browserPayloads) {
  await build({
    entryPoints: [`src/browser/${name}.js`],
    bundle: true,
    platform: "browser",
    target: "chrome120",
    format: "iife",
    globalName,
    outfile: `dist/${name}.js`,
    ...(name === "session-storage" ? {} : { banner: { js: `/*!\n${codecLicense}\n*/` } }),
  });
}

await build({
  entryPoints: ["src/restore.ts"],
  bundle: true,
  external: ["playwright-core"],
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "dist/restore.mjs",
});
