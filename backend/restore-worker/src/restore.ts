import { Buffer } from "node:buffer";
import type { Browser } from "playwright-core";
import { chromium } from "playwright-core";
import { restoreStorage } from "./restore-storage.js";
import { restoreTargets, type TargetResult } from "./restore-targets.js";
import { capsuleSchema, type Capsule } from "./schema.js";

class InvalidCapsule extends Error {}

async function readCapsule(): Promise<Capsule> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 64 * 1024 * 1024) throw new InvalidCapsule();
    chunks.push(bytes);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks, size).toString("utf8"), (_key, value: unknown) =>
      value === null ? undefined : value,
    );
  } catch {
    throw new InvalidCapsule();
  }

  const result = capsuleSchema.safeParse(parsed);
  if (!result.success) {
    throw new InvalidCapsule();
  }
  return result.data;
}

async function restore(browser: Browser, capsule: Capsule): Promise<TargetResult> {
  const context = browser.contexts()[0];
  if (!context) throw new Error("browser has no default context");

  const browserCDP = await browser.newBrowserCDPSession();
  if (capsule.storageState) {
    await restoreStorage(context, browserCDP, capsule.storageState);
  }

  return restoreTargets(context, browserCDP, capsule.initialTargets ?? []);
}

async function main(): Promise<void> {
  if (process.argv.length !== 3 || !/^http:\/\/127\.0\.0\.1:\d+$/.test(process.argv[2]))
    throw new Error("usage: restore <cdp-url>");

  const capsule = await readCapsule();
  const browser = await chromium.connectOverCDP(process.argv[2], { timeout: 15_000 });

  try {
    const result = await restore(browser, capsule);
    process.stdout.write(JSON.stringify(result));
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    error instanceof InvalidCapsule
      ? "invalid browser initialization\n"
      : "browser restore failed\n",
  );
  process.exitCode = 1;
});
