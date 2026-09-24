import { once } from "node:events";
import { readFile } from "node:fs/promises";
import type { Browser, CDPSession } from "playwright-core";
import { chromium } from "playwright-core";
import type { z } from "zod";
import { errorMessage } from "./browser/error.js";
import { restoreStorage } from "./restore-storage.js";
import { restoreTargets, type TargetResult } from "./restore-targets.js";
import { capsuleSchema, type Capsule } from "./schema.js";

const usage = "usage: aperture-browser-restore validate <capsule> | restore <cdp-url> <capsule>";

class InvalidCapsule extends Error {}
class UsageError extends Error {}

interface CookieDiagnosticSource {
  name: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
  hostOnly?: boolean;
  partitionKey?: unknown;
}

function logCookies(stage: string, cookies: readonly CookieDiagnosticSource[]): void {
  if (process.env.BROWSER_RESTORE_DIAGNOSTICS !== "1") return;

  const metadata = cookies.map((cookie) => ({
    name: cookie.name,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    hostOnly: cookie.hostOnly ?? !cookie.domain.startsWith("."),
    partitioned: cookie.partitionKey != null,
  }));
  process.stderr.write(`browser restore cookies ${stage}: ${JSON.stringify(metadata)}\n`);
}

async function logBrowserCookies(stage: string, browserCDP: CDPSession): Promise<void> {
  if (process.env.BROWSER_RESTORE_DIAGNOSTICS !== "1") return;

  const result = (await browserCDP.send("Storage.getCookies")) as {
    cookies: CookieDiagnosticSource[];
  };
  logCookies(stage, result.cookies);
}

async function readCapsule(path: string): Promise<Capsule> {
  const text = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    // Treat explicit nulls like omitted optional fields.
    parsed = JSON.parse(text, (_key, value: unknown) => (value === null ? undefined : value));
  } catch {
    throw new InvalidCapsule("request body is not valid JSON");
  }

  const result = capsuleSchema.safeParse(parsed);
  if (!result.success) throw new InvalidCapsule(describeIssue(result.error.issues[0]));
  return result.data;
}

// Formats the first validation issue as "initialTargets[0].url: message". Issues never
// include input values, which may be sensitive.
function describeIssue(issue: z.core.$ZodIssue | undefined): string {
  if (!issue) return "invalid browser initialization";
  const path = issue.path
    .map((part, index) =>
      typeof part === "number" ? `[${part}]` : `${index === 0 ? "" : "."}${String(part)}`,
    )
    .join("");
  return path === "" ? issue.message : `${path}: ${issue.message}`;
}

async function restore(browser: Browser, capsule: Capsule): Promise<TargetResult> {
  const context = browser.contexts()[0];
  if (!context) throw new Error("browser has no default context");

  const browserCDP = await browser.newBrowserCDPSession();
  if (capsule.storageState) {
    logCookies("received", capsule.storageState.cookies);
    await restoreStorage(context, browserCDP, capsule.storageState);
    await logBrowserCookies("after storage restore", browserCDP);
  }

  const result = await restoreTargets(context, browserCDP, capsule.initialTargets ?? []);
  if (capsule.storageState) await logBrowserCookies("after target navigation", browserCDP);
  return result;
}

async function main([command, ...args]: string[]): Promise<void> {
  if (command === "validate" && args.length === 1) {
    await readCapsule(args[0]);
    return;
  }

  const [cdpURL, capsulePath] = args;
  if (command !== "restore" || args.length !== 2 || !/^http:\/\/127\.0\.0\.1:\d+$/.test(cdpURL)) {
    throw new UsageError(usage);
  }

  const capsule = await readCapsule(capsulePath);
  const browser = await chromium.connectOverCDP(cdpURL, { timeout: 15_000 });
  try {
    const result = await restore(browser, capsule);
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(`${JSON.stringify(result)}\n`, (error) =>
        error ? reject(error) : resolve(),
      );
    });

    // Preload scripts added through this CDP connection disappear when it closes. Go
    // installs the remaining session storage scripts itself, then closes stdin.
    process.stdin.resume();
    await once(process.stdin, "end");
  } finally {
    await browser.close();
  }
}

function exit(code: number, message: string): void {
  process.stderr.write(`${message}\n`, () => process.exit(code));
}

main(process.argv.slice(2)).catch((error: unknown) => {
  // Exit code 2 tells Go that the capsule itself is invalid; stderr then holds the reason.
  if (error instanceof InvalidCapsule) exit(2, error.message);
  else if (error instanceof UsageError) exit(64, error.message);
  // Go only forwards this diagnostic to local logs when explicitly enabled. Public API
  // errors stay generic because details may contain restored browser data.
  else exit(1, errorMessage(error));
});
