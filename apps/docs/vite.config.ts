import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { fumadocsMdx } from "fumadocs-mdx/vite";
import { defineConfig, lazyPlugins } from "vite-plus";

export default defineConfig({
  plugins: lazyPlugins(() => [
    fumadocsMdx(),
    tailwindcss(),
    tanstackStart({
      prerender: { enabled: true, crawlLinks: true, failOnError: true },
      // What no page links to: the search's index, the API's document, and what an address
      // with no page gets, which is a file at the top and not a directory's index.
      pages: [
        { path: "/api/search" },
        { path: "/openapi.json" },
        { path: "/404", prerender: { autoSubfolderIndex: false } },
      ],
    }),
    viteReact(),
  ]),
});
