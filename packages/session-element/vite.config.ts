import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [tailwindcss()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    target: "es2023",
    modulePreload: false,
    rolldownOptions: {
      input: { "aperture-session": "src/index.tsx", "aperture-session-view": "src/headless.tsx" },
      preserveEntrySignatures: "exports-only",
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "aperture-[hash].js",
      },
    },
  },
});
