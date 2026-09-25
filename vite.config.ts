import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
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
    plugins: ["typescript", "unicorn", "oxc", "import"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      "import/no-nodejs-modules": "error",
      "no-restricted-globals": [
        "error",
        "process",
        "Buffer",
        "global",
        "__dirname",
        "__filename",
        "require",
        "module",
        "exports",
        "setImmediate",
        "clearImmediate",
      ],
    },
    overrides: [
      {
        files: ["**/vite.config.ts"],
        rules: { "import/no-nodejs-modules": "off", "no-restricted-globals": "off" },
      },
    ],
    options: { typeAware: true, typeCheck: true },
  },
});
