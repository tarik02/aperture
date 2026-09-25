import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: { index: "src/index.ts" },
    platform: "browser",
    dts: true,
    sourcemap: true,
    deps: {
      // The shared UI components are private to this repo, so they ship inside the bundle.
      alwaysBundle: [/^@aperture-browser\/ui(\/|$)/],
      // Kept as bare subpaths; the package has no exports map to resolve them against.
      neverBundle: [/^@atlaskit\//],
    },
  },
});
