import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [tailwindcss()],
  base: "./",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  experimental: {
    renderBuiltUrl: (filename, { hostType }) =>
      hostType === "js"
        ? { runtime: `new URL(${JSON.stringify(`./${filename}`)}, import.meta.url).href` }
        : undefined,
  },
  build: {
    target: "es2023",
    modulePreload: false,
    assetsInlineLimit: (file) => !file.endsWith(".woff2"),
    rolldownOptions: {
      input: { "aperture-session": "src/index.tsx", "aperture-session-view": "src/headless.tsx" },
      preserveEntrySignatures: "exports-only",
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "aperture-[hash].js",
        assetFileNames: "files/[name]-[hash][extname]",
      },
    },
  },
});
