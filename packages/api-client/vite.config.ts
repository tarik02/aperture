import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: { index: "src/index.ts", passkeys: "src/passkeys.ts" },
    platform: "neutral",
    dts: true,
    sourcemap: true,
    publint: true,
  },
});
