import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { defineConfig } from "vite-plus";

// The session embeds the page in its binary, so the build is the one file `dist/index.html`
// with its script, styles and fonts inside.
export default defineConfig({
  plugins: [tailwindcss(), viteReact(), viteSingleFile()],
  build: {
    outDir: "dist",
    target: "es2023",
  },
});
