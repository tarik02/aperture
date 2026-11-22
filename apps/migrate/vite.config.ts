import { defineConfig } from "vite-plus";

export default defineConfig({
  // The program as node runs it: one file with this workspace's own packages in it, whose
  // sources node does not run as they are. What comes from the registry stays beside it.
  pack: {
    entry: { main: "src/main.ts" },
    platform: "node",
    format: "esm",
    deps: { alwaysBundle: [/^@aperture-browser\//u], onlyBundle: false },
    dts: false,
    sourcemap: true,
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // The end-to-end file starts a database, a control plane and a node with a session.
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
