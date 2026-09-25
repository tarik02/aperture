import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [tailwindcss()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    target: "es2023",
    assetsInlineLimit: () => true,
    lib: {
      entry: { "aperture-session": "src/index.tsx", "aperture-session-view": "src/headless.tsx" },
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
    },
    rolldownOptions: {
      output: {
        minify: true,
        chunkFileNames: "aperture-[hash].js",
      },
    },
  },
});
