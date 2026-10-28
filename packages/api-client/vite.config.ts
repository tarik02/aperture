import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: { index: "src/index.ts", passkeys: "src/passkeys.ts", "url-path": "src/url-path.ts" },
    platform: "neutral",
    dts: true,
    sourcemap: true,
    publint: true,
  },
});
