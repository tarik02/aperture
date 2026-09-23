import { Buffer } from "node:buffer";
import type { Browser } from "playwright-core";
import { chromium } from "playwright-core";
import { restoreStorage } from "./restore-storage.js";
import { restoreTargets, type TargetResult } from "./restore-targets.js";
import { capsuleSchema, type Capsule } from "./schema.js";

class InvalidCapsule extends Error {}

class WorkerInput {
  private readonly chunks = process.stdin[Symbol.asyncIterator]();
  private remaining = Buffer.alloc(0);

  async readLine(maxBytes: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    let size = 0;

    while (true) {
      if (this.remaining.length === 0) {
        const next = await this.chunks.next();
        if (next.done) throw new Error("restore worker input closed");
        this.remaining = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      }

      const newline = this.remaining.indexOf(10);
      const length = newline < 0 ? this.remaining.length : newline;
      size += length;
      if (size > maxBytes) throw new Error("restore worker input exceeded its limit");

      parts.push(this.remaining.subarray(0, length));
      this.remaining = newline < 0 ? Buffer.alloc(0) : this.remaining.subarray(newline + 1);
      if (newline >= 0) return Buffer.concat(parts, size);
    }
  }
}

async function readCapsule(input: WorkerInput): Promise<Capsule> {
  let parsed: unknown;
  try {
    const bytes = await input.readLine(64 * 1024 * 1024);
    parsed = JSON.parse(bytes.toString("utf8"), (_key, value: unknown) =>
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

  const input = new WorkerInput();
  const capsule = await readCapsule(input);
  const browser = await chromium.connectOverCDP(process.argv[2], { timeout: 15_000 });

  try {
    const result = await restore(browser, capsule);
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(`${JSON.stringify(result)}\n`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    const acknowledgment = await input.readLine(16);
    if (acknowledgment.toString("utf8") !== "ready") {
      throw new Error("browser restore handoff was not acknowledged");
    }
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  const exitCode = error instanceof InvalidCapsule ? 2 : 1;
  process.stderr.write(
    error instanceof InvalidCapsule
      ? "invalid browser initialization\n"
      : "browser restore failed\n",
    () => process.exit(exitCode),
  );
});
