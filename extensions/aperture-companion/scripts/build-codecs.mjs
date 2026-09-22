import { readFileSync } from "node:fs";
import { build } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const license = readFileSync(
  new URL("../../../packages/browser-state/LICENSE", import.meta.url),
  "utf8",
);
const banner = `/*!\n${license}\n*/`;

function licenseBannerPlugin() {
  return {
    name: "aperture-codec-license-banner",
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type === "chunk") {
          output.code = `${banner}\n${output.code}`;
        }
      }
    },
  };
}

await build({
  configFile: false,
  publicDir: false,
  root,
  plugins: [licenseBannerPlugin()],
  build: {
    emptyOutDir: false,
    lib: {
      entry: "src/capture-codec-runtime.ts",
      formats: ["iife"],
      name: "ApertureCaptureCodecRuntime",
      fileName: () => "capture-codec.js",
    },
    minify: true,
    outDir: "dist",
    target: "chrome120",
  },
});
