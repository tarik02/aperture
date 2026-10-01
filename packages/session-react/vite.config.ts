import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: { index: "src/index.ts", headless: "src/headless.ts" },
    platform: "browser",
    // The re-exported ui providers sit outside this tsconfig; lazy emit fails on them.
    dts: { eager: true },
    sourcemap: true,
    deps: {
      alwaysBundle: [/^@aperture-browser\/ui(\/|$)/],
      neverBundle: [/^@atlaskit\//],
    },
  },
});
