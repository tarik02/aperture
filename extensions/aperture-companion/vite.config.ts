import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

const devalueLicense = readFileSync(
  new URL("../../packages/browser-state/node_modules/devalue/LICENSE", import.meta.url),
  "utf8",
);

export default defineConfig({
  plugins: [tailwindcss(), react()],
  builder: {
    // Build the extension pages first (they empty dist), then the page-injected codec.
    async buildApp(builder) {
      await builder.build(builder.environments.client);
      await builder.build(builder.environments.codec);
    },
  },
  environments: {
    client: {
      build: {
        modulePreload: false,
        outDir: "dist",
        rollupOptions: {
          input: {
            popup: "popup.html",
            background: "src/background.ts",
          },
          output: {
            entryFileNames: "[name].js",
          },
        },
      },
    },
    // Injected into captured pages with chrome.scripting.executeScript, so it has to be a
    // self-contained classic script that registers the codec on the page's global object.
    codec: {
      consumer: "client",
      build: {
        outDir: "dist",
        emptyOutDir: false,
        copyPublicDir: false,
        target: "chrome120",
        rolldownOptions: {
          input: "src/capture-codec-runtime.ts",
          output: {
            format: "iife",
            entryFileNames: "capture-codec.js",
            postBanner: `/*!\n${devalueLicense}\n*/`,
          },
        },
      },
    },
  },
});
