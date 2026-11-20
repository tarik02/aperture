import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Sessions take seconds to start, and each file starts its own.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // A session is a browser and a compositor: a few at a time is what a machine carries.
    maxWorkers: 3,
  },
});
