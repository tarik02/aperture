import { readFileSync } from "node:fs";
import { build } from "vite";

const codecLicense = readFileSync(
  new URL("../../packages/browser-state/node_modules/devalue/LICENSE", import.meta.url),
  "utf8",
);

const licenseBanner = {
  name: "browser-state-license",
  generateBundle(_options, bundle) {
    for (const output of Object.values(bundle)) {
      if (output.type === "chunk") {
        output.code = `/*!\n${codecLicense}\n*/\n${output.code}`;
      }
    }
  },
};

const browserPayloads = [
  ["target", "ApertureTargetRestore"],
  ["session-storage", "ApertureSessionStorageRestore"],
  ["origin-storage", "ApertureOriginStorageRestore"],
];

for (const [index, [name, globalName]] of browserPayloads.entries()) {
  await build({
    configFile: false,
    plugins: name === "session-storage" ? [] : [licenseBanner],
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
