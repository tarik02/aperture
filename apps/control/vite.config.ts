import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Each file starts a database of its own, and one of them a node with a session.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    maxWorkers: 2,
  },
});
