import tailwindcss from "@tailwindcss/vite";
import { defineConfig, lazyPlugins } from "vite-plus";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";

const devProxyTarget = process.env.APERTURE_DEV_PROXY_TARGET;

const config = defineConfig({
  experimental: {
    bundledDev: true,
  },
  fmt: {
    ignorePatterns: ["src/routeTree.gen.ts"],
  },
  lint: {
    ignorePatterns: ["dist/**", "src/routeTree.gen.ts"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  resolve: { tsconfigPaths: true },
  build: {
    outDir: "dist",
  },
  server: devProxyTarget
    ? {
        proxy: {
          "/api": {
            target: devProxyTarget,
            changeOrigin: true,
          },
          "/auth": {
            target: devProxyTarget,
            changeOrigin: true,
          },
          "/sessions": {
            target: devProxyTarget,
            changeOrigin: true,
            ws: true,
          },
        },
      }
    : {},
  plugins: lazyPlugins(() => [
    tailwindcss(),
    tanstackStart({
      spa: {
        enabled: true,
        prerender: {
          outputPath: "/index.html",
        },
      },
    }),
    viteReact(),
  ]),
});

export default config;
