import { defineConfig } from "vite-plus";

// The extension's MV3 service worker, bundled into one module. public/ holds the
// manifest and the marker page, which are copied as they are.
export default defineConfig({
  build: {
    outDir: "dist",
    target: "chrome151",
    rolldownOptions: {
      input: "src/service-worker.ts",
      output: { format: "es", entryFileNames: "service_worker.js" },
    },
  },
});
