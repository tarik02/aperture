import { defineConfig } from "vite-plus";

// Formatting and lint rules for the whole workspace; `vp fmt` and `vp lint` run from the root.
export default defineConfig({
  fmt: {
    // The Go side, the OpenAPI spec and the docs keep their own formatting.
    ignorePatterns: [
      "**/*.gen.ts",
      "*.md",
      "api/**",
      "docs/**",
      "internal/**",
      "packaging/**",
      "skills/**",
      "pnpm-lock.yaml",
    ],
  },
  lint: {
    ignorePatterns: ["**/dist/**", "**/*.gen.ts"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});
