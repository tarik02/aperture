import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [tailwindcss(), viteReact()],
  build: {
    outDir: "dist",
    target: "es2023",
  },
});
