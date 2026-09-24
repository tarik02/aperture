import { createInterface } from "node:readline";
import type { Browser } from "playwright-core";
import { chromium } from "playwright-core";
import { restoreStorage } from "./restore-storage.js";
import { restoreTargets, type TargetResult } from "./restore-targets.js";
import { capsuleSchema, type Capsule } from "./schema.js";

class InvalidCapsule extends Error {}

async function readCapsule(lines: AsyncIterator<string>): Promise<Capsule> {
  const line = await lines.next();
  if (line.done) throw new InvalidCapsule();

  let parsed: unknown;
  try {
    // Treat explicit nulls like omitted optional fields.
    parsed = JSON.parse(line.value, (_key, value: unknown) => (value === null ? undefined : value));
  } catch {
    throw new InvalidCapsule();
  }

  const result = capsuleSchema.safeParse(parsed);
  if (!result.success) throw new InvalidCapsule();
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

  const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  const capsule = await readCapsule(lines);
  const browser = await chromium.connectOverCDP(process.argv[2], { timeout: 15_000 });

  try {
    const result = await restore(browser, capsule);
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(`${JSON.stringify(result)}\n`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    // Go closes stdin after installing the replacement session-storage scripts.
    const handoff = await lines.next();
    if (!handoff.done) throw new Error("unexpected restore worker input");
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  // Exit code 2 tells Go that the request itself was invalid.
  const [exitCode, message] =
    error instanceof InvalidCapsule
      ? [2, "invalid browser initialization"]
      : [1, "browser restore failed"];
  process.stderr.write(`${message}\n`, () => process.exit(exitCode));
});
