import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [tailwindcss()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    target: "es2023",
    assetsInlineLimit: () => true,
    lib: { entry: "src/index.tsx", formats: ["es"], fileName: () => "aperture-session.js" },
    rolldownOptions: { output: { minify: true } },
  },
});
