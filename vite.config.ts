import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: [
      "**/gen/**",
      "*.md",
      "*.toml",
      "*.lock",
      "crates/**",
      "proto/**",
      "e2e/e2e.mjs",
      "target/**",
      "pnpm-lock.yaml",
    ],
  },
  lint: {
    ignorePatterns: ["**/dist/**", "**/gen/**", "crates/**", "e2e/e2e.mjs", "target/**"],
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
      {
        // The checks run in Node, beside the programs they start.
        files: ["e2e/**"],
        rules: { "import/no-nodejs-modules": "off", "no-restricted-globals": "off" },
      },
    ],
    options: { typeAware: true, typeCheck: true },
  },
});
