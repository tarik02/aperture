import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, lazyPlugins, type Plugin } from "vite-plus";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";

const devProxyTarget = process.env.APERTURE_DEV_PROXY_TARGET;

const scalarStandalone = path.join(
  path.dirname(createRequire(import.meta.url).resolve("@scalar/api-reference")),
  "browser/standalone.js",
);

function scalarApiReference(): Plugin {
  return {
    name: "aperture:scalar-api-reference",
    apply: "build",
    applyToEnvironment: (environment) => environment.name === "client",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "docs/api-reference.js",
        source: readFileSync(scalarStandalone),
      });
    },
  };
}

const config = defineConfig({
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
    scalarApiReference(),
  ]),
});

export default config;
