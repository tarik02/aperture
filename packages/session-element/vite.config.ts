import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";

// One self-contained module that registers <aperture-session>: React, the session view,
// its styles and fonts are all inside.
export default defineConfig({
  plugins: [tailwindcss()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    target: "es2023",
    // Fonts become data URLs in the inlined stylesheet.
    assetsInlineLimit: () => true,
    lib: { entry: "src/index.tsx", formats: ["es"], fileName: () => "aperture-session.js" },
    // Library builds keep whitespace by default; this file is loaded as is.
    rolldownOptions: { output: { minify: true } },
  },
});
