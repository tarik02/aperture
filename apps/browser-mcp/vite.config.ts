import { defineConfig } from "vite-plus";

// The Node host Go spawns. Everything but playwright-core, which the Nix package
// installs next to it, is bundled.
export default defineConfig({
  ssr: { noExternal: true, external: ["playwright-core"] },
  build: {
    ssr: "src/main.ts",
    target: "node26",
    outDir: "dist",
    rolldownOptions: { output: { entryFileNames: "main.mjs" } },
  },
});
