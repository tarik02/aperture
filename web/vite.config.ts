import tailwindcss from "@tailwindcss/vite";
import { defineConfig, lazyPlugins } from "vite-plus";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";

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
    {
      name: "retryable-route-components",
      enforce: "post",
      transform(code, id) {
        if (id.includes("node_modules") || !code.includes("lazyRouteComponent")) {
          return;
        }
        return `import { retryableLazyRouteComponent } from "#/lib/retryable-route-component.ts";\n${code.replaceAll("lazyRouteComponent(", "retryableLazyRouteComponent(")}`;
      },
    },
    viteReact(),
  ]),
});

export default config;
