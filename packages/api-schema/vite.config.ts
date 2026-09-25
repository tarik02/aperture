import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: { index: "src/api.gen.ts" },
    platform: "neutral",
    dts: true,
    sourcemap: true,
    publint: true,
  },
});
