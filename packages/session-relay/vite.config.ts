import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: { index: "src/index.ts", node: "src/node.ts" },
    platform: "node",
    dts: true,
    sourcemap: true,
    publint: true,
  },
});
