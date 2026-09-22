import { Resvg } from "@resvg/resvg-js";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const extensionRoot = fileURLToPath(new URL("..", import.meta.url));
const source = await readFile(`${extensionRoot}/public/icon.svg`);

await Promise.all(
  [16, 32, 48, 128].map(async (size) => {
    const icon = new Resvg(source, {
      fitTo: { mode: "width", value: size },
    });
    await writeFile(`${extensionRoot}/public/icon-${size}.png`, icon.render().asPng());
  }),
);
