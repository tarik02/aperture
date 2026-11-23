import { defineConfig } from "vite-plus";

/**
 * How many files' checks run at once. Each file has a session or a node of its own, which
 * is a browser and a compositor, and most have a browser that watches it as well, drawing
 * without a GPU: two files at once keep the four cores of a hosted runner busy, and more
 * make every wait of the checks longer than the checks give it. `APERTURE_E2E_WORKERS`
 * says otherwise, for a machine that carries more.
 */
const told = Number(process.env["APERTURE_E2E_WORKERS"]);
const workers = Number.isInteger(told) && told > 0 ? told : 2;

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["src/failures-setup.ts"],
    // Sessions take seconds to start, and each file starts its own.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    maxWorkers: workers,
  },
});
