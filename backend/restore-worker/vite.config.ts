import { readFileSync } from "node:fs";
import { defineConfig, type EnvironmentOptions } from "vite-plus";

const license = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const devalueLicense = license("../../packages/browser-state/node_modules/devalue/LICENSE");
const idbLicense = license("./node_modules/idb/LICENSE");

// Scripts evaluated inside browser pages. Each one is a self-contained IIFE that
// exposes `run(state)` under its global name (see src/payload-source.ts).
function browserPayload(name: string, globalName: string, licenses: string[]): EnvironmentOptions {
  return {
    consumer: "client",
    build: {
      target: "chrome151",
      emptyOutDir: false,
      rolldownOptions: {
        input: `src/browser/${name}.ts`,
        preserveEntrySignatures: "strict",
        output: {
          format: "iife",
          name: globalName,
          entryFileNames: `${name}.js`,
          ...(licenses.length > 0 && { postBanner: `/*!\n${licenses.join("\n\n")}\n*/` }),
        },
      },
    },
  };
}

export default defineConfig({
  build: { outDir: "dist" },
  builder: {
    // Build only the environments below, not Vite's default index.html client.
    async buildApp(builder) {
      for (const [name, environment] of Object.entries(builder.environments)) {
        if (name !== "client" && name !== "ssr") await builder.build(environment);
      }
    },
  },
  environments: {
    target: browserPayload("target", "ApertureTargetRestore", [devalueLicense]),
    sessionStorage: browserPayload("session-storage", "ApertureSessionStorageRestore", []),
    originStorage: browserPayload("origin-storage", "ApertureOriginStorageRestore", [
      devalueLicense,
      idbLicense,
    ]),
    // The Node worker Go spawns. playwright-core comes from the Nix package at runtime.
    worker: {
      consumer: "server",
      resolve: { noExternal: ["zod"], external: ["playwright-core"] },
      build: {
        target: "node26",
        emptyOutDir: false,
        rolldownOptions: {
          input: "src/restore.ts",
          output: { entryFileNames: "restore.mjs" },
        },
      },
    },
  },
});
