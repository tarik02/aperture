import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { fumadocsMdx } from "fumadocs-mdx/vite";
import { defineConfig, lazyPlugins } from "vite-plus";

export default defineConfig({
  base: process.env.DOCS_BASE_PATH ?? "/",
  resolve: { tsconfigPaths: true },
  plugins: lazyPlugins(() => [
    fumadocsMdx(),
    tailwindcss(),
    tanstackStart({
      prerender: { enabled: true, crawlLinks: true },
      pages: [{ path: "/api/search" }],
    }),
    viteReact(),
  ]),
});
