import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite-plus";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/**
 * What a session's runner reads and writes a browser's storage and documents with, as a
 * module: the extension takes a tab's state with the very code a session puts it back
 * with, so that the two cannot come to disagree on its form.
 */
const runnerState = (): Plugin => {
  const id = "virtual:runner-state";
  const resolved = `\0${id}`;
  return {
    name: "aperture:runner-state",
    resolveId: (source) => (source === id ? resolved : undefined),
    load(loaded) {
      if (loaded !== resolved) return undefined;
      const state = "../../crates/runner/src/live/state";
      return [
        `export const stored = ${read(`${state}/stored.js`)};`,
        `export const documentOf = ${read(`${state}/document.js`)};`,
      ].join("\n");
    },
  };
};

/**
 * A browser takes a version of up to four numbers and nothing else. The first three are
 * the release's; the fourth is a prerelease's own number, and the most there is for a
 * release that is none, which so comes after its prereleases.
 */
const browserVersion = (version: string) => {
  const [release = "", prerelease] = version.split("-");
  const number = prerelease === undefined ? 65_535 : Number(prerelease.split(".").at(-1));
  return `${release}.${Number.isInteger(number) ? number : 0}`;
};

/** The manifest, with the version the package has. */
const manifest = (): Plugin => ({
  name: "aperture:manifest",
  generateBundle() {
    const { version } = JSON.parse(read("package.json")) as { version: string };
    this.emitFile({
      type: "asset",
      fileName: "manifest.json",
      source: `${JSON.stringify(
        {
          ...(JSON.parse(read("manifest.json")) as Record<string, unknown>),
          version: browserVersion(version),
          version_name: version,
        },
        null,
        2,
      )}\n`,
    });
  },
});

export default defineConfig({
  plugins: [tailwindcss(), react(), runnerState()],
  builder: {
    // The extension's pages first, since they empty dist, then what is put into a page.
    async buildApp(builder) {
      await builder.build(builder.environments["client"]!);
      await builder.build(builder.environments["codec"]!);
    },
  },
  environments: {
    client: {
      build: {
        outDir: "dist",
        target: "chrome140",
        modulePreload: false,
        rolldownOptions: {
          input: { popup: "popup.html", background: "src/background.ts" },
          output: { entryFileNames: "[name].js" },
          plugins: [manifest()],
        },
      },
    },
    // Put into the pages a state is taken from with chrome.scripting.executeScript, so it
    // is one classic script, which leaves what it has on the page's global object.
    codec: {
      consumer: "client",
      build: {
        outDir: "dist",
        target: "chrome140",
        emptyOutDir: false,
        copyPublicDir: false,
        rolldownOptions: {
          input: "src/capture-codec.ts",
          output: { format: "iife", entryFileNames: "capture-codec.js" },
        },
      },
    },
  },
  test: { include: ["tests/**/*.test.ts"] },
});
