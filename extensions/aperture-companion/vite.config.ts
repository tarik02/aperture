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
    // The extension pages first, since they empty dist, then the page-injected codec.
    async buildApp(builder) {
      await builder.build(builder.environments.client);
      await builder.build(builder.environments.codec);
    },
  },
  environments: {
    client: {
      build: {
        outDir: "dist",
        target: "chrome151",
        modulePreload: false,
        rolldownOptions: {
          input: { popup: "popup.html", background: "src/background.ts" },
          output: { entryFileNames: "[name].js" },
        },
      },
    },
    // Injected into captured pages with chrome.scripting.executeScript, so it has to be a
    // self-contained classic script that registers the codec on the page's global object.
    codec: {
      consumer: "client",
      build: {
        outDir: "dist",
        target: "chrome151",
        emptyOutDir: false,
        copyPublicDir: false,
        rolldownOptions: {
          input: "src/capture-codec.ts",
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
