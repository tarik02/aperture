import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: { index: "src/index.ts" },
    platform: "browser",
    dts: true,
    sourcemap: true,
    deps: {
      alwaysBundle: [/^@aperture-browser\/ui(\/|$)/],
      neverBundle: [/^@atlaskit\//],
    },
  },
});
