// Finishes dist/styles.css for embedding: Tailwind's remaining theme variables move from
// :root onto .aperture-root, and the font files its relative url()s name are copied.
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const stylesheet = "dist/styles.css";
const require = createRequire(import.meta.url);
const fontDir = dirname(require.resolve("@fontsource-variable/geist/index.css"));

const css = (await readFile(stylesheet, "utf8")).replaceAll(
  /:root,\s*:host/g,
  ".aperture-root,:host",
);
if (/:root\b/.test(css)) {
  throw new Error(`${stylesheet} still styles :root`);
}
await writeFile(stylesheet, css);

const fonts = new Set(Array.from(css.matchAll(/url\(\.\/files\/([^)]+)\)/g), (match) => match[1]!));
await mkdir("dist/files", { recursive: true });
await Promise.all(
  Array.from(fonts, (file) => copyFile(join(fontDir, "files", file), join("dist/files", file))),
);
console.log(`Scoped ${stylesheet} and copied ${fonts.size} font files`);
