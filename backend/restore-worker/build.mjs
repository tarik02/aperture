import { readFileSync } from "node:fs";
import { build } from "vite";

const codecLicense = readFileSync(
  new URL("../../packages/browser-state/node_modules/devalue/LICENSE", import.meta.url),
  "utf8",
);
const idbLicense = readFileSync(new URL("./node_modules/idb/LICENSE", import.meta.url), "utf8");

function licenseBanner(licenses) {
  return {
    name: "browser-payload-licenses",
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type === "chunk") {
          output.code = `/*!\n${licenses.join("\n\n")}\n*/\n${output.code}`;
        }
      }
    },
  };
}

const browserPayloads = [
  { name: "target", globalName: "ApertureTargetRestore", licenses: [codecLicense] },
  { name: "session-storage", globalName: "ApertureSessionStorageRestore", licenses: [] },
  {
    name: "origin-storage",
    globalName: "ApertureOriginStorageRestore",
    licenses: [codecLicense, idbLicense],
  },
];

for (const [index, { name, globalName, licenses }] of browserPayloads.entries()) {
  await build({
    configFile: false,
    plugins: licenses.length > 0 ? [licenseBanner(licenses)] : [],
    build: {
      outDir: "dist",
      emptyOutDir: index === 0,
      target: "chrome151",
      lib: {
        entry: `src/browser/${name}.ts`,
        name: globalName,
        formats: ["iife"],
        fileName: () => `${name}.js`,
      },
    },
  });
}

await build({
  configFile: false,
  ssr: { noExternal: ["zod"] },
  build: {
    outDir: "dist",
    emptyOutDir: false,
    target: "node26",
    ssr: "src/restore.ts",
    rolldownOptions: {
      external: ["playwright-core"],
      output: { entryFileNames: "restore.mjs" },
    },
  },
});
