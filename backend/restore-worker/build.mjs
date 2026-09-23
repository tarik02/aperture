import { readFileSync } from "node:fs";
import { build } from "vite";

const codecLicense = readFileSync(
  new URL("../../packages/browser-state/LICENSE", import.meta.url),
  "utf8",
);
const browserPayloads = [
  ["target", "ApertureTargetRestore"],
  ["session-storage", "ApertureSessionStorageRestore"],
  ["origin-storage", "ApertureOriginStorageRestore"],
];

for (const [index, [name, globalName]] of browserPayloads.entries()) {
  await build({
    configFile: false,
    plugins:
      name === "session-storage"
        ? []
        : [
            {
              name: "browser-state-license",
              generateBundle(_, bundle) {
                for (const output of Object.values(bundle)) {
                  if (output.type === "chunk") output.code = `/*!\n${codecLicense}\n*/\n${output.code}`;
                }
              },
            },
          ],
    build: {
      outDir: "dist",
      emptyOutDir: index === 0,
      target: "chrome120",
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
    target: "node22",
    ssr: "src/restore.ts",
    rolldownOptions: {
      external: ["playwright-core"],
      output: { entryFileNames: "restore.mjs" },
    },
  },
});
