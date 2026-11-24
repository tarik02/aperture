import { defineConfig } from "vite-plus";

// As the checks of real sessions have it, and for their reasons: one of these files starts a
// node with sessions, and a browser that watches the console.
const told = Number(process.env["APERTURE_E2E_WORKERS"]);
const workers = Number.isInteger(told) && told > 0 ? told : 2;

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
    globalSetup: ["../../e2e/src/failures-setup.ts"],
    // Each file starts a database of its own, and one of them a node with a session.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    maxWorkers: workers,
  },
});
