import { build } from "esbuild";

await build({
  entryPoints: ["src/restore.ts"],
  bundle: true,
  external: ["playwright-core"],
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: "dist/restore.cjs",
  loader: { ".txt": "text" },
});
