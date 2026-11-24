import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: { index: "src/index.ts", client: "src/client.ts", errors: "src/errors.ts" },
    platform: "neutral",
    dts: true,
    sourcemap: true,
    publint: true,
  },
});
