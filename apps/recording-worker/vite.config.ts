import { defineConfig } from "vite-plus";

export default defineConfig({
  ssr: { noExternal: true },
  build: {
    ssr: "src/main.ts",
    target: "node26",
    outDir: "dist",
    rolldownOptions: { output: { entryFileNames: "main.mjs" } },
  },
});
