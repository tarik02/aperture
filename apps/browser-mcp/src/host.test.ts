import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

// Runs the host against a real Chromium, so a Playwright upgrade that breaks the
// internals it relies on fails here. Skipped where no Chromium is installed.
const chromium = process.env.CHROMIUM ?? "chromium";
const available = !spawnSync(chromium, ["--version"]).error;

const groupAlive = (pid: number) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Ends a process group: asks it to exit, then kills what is left, and waits until it is gone. */
const stopGroup = async (pid: number) => {
  const started = Date.now();
  for (let signal: NodeJS.Signals = "SIGTERM"; groupAlive(pid); ) {
    if (Date.now() - started > 5_000) signal = "SIGKILL";
    try {
      process.kill(-pid, signal);
    } catch {
      /* already gone */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe.skipIf(!available)("browser MCP host", () => {
  let profile: string;
  let browser: ChildProcess;
  let host: ChildProcess;
  let buffer = "";
  let nextId = 0;
  const pending = new Map<number, (message: { result?: any; error?: unknown }) => void>();

  const request = (method: string, params: object) =>
    new Promise<any>((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      host.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const call = async (name: string, args: object) =>
    (await request("tools/call", { name, arguments: args })).result;

  beforeAll(async () => {
    profile = mkdtempSync(join(tmpdir(), "browser-mcp-"));
    browser = spawn(
      chromium,
      [
        "--headless",
        "--no-sandbox",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
      { stdio: "ignore", detached: true }, // its own process group, to end all of Chromium's processes
    );
    const portFile = join(profile, "DevToolsActivePort");
    for (let attempt = 0; !existsSync(portFile) && attempt < 200; attempt++)
      await new Promise((r) => setTimeout(r, 50));
    const port = readFileSync(portFile, "utf8").split("\n")[0];

    host = spawn(
      process.execPath,
      [
        join(import.meta.dirname, "main.ts"),
        "--cdp-endpoint",
        `http://127.0.0.1:${port}`,
        "--output-dir",
        profile,
      ],
      {
        stdio: ["pipe", "pipe", "inherit"],
      },
    );
    host.stdout!.on("data", (chunk) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        pending.get(message.id)?.(message);
      }
    });
    await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    host.stdin!.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
  }, 60_000);

  afterAll(async () => {
    host?.kill();
    // Chromium keeps writing its profile until every one of its processes has exited.
    if (browser?.pid) await stopGroup(browser.pid);
    rmSync(profile, { recursive: true, force: true });
  });

  it("lists the pointer tools in place of Playwright's", async () => {
    const names = (await request("tools/list", {})).result.tools.map(
      (tool: { name: string }) => tool.name,
    );
    expect(names).toEqual(
      expect.arrayContaining([
        "browser_click",
        "browser_move",
        "browser_drag",
        "browser_scroll",
        "browser_snapshot",
      ]),
    );
    expect(names.filter((name: string) => /^browser_(hover|mouse_)/.test(name))).toEqual([]);
  });

  it("clicks the element a snapshot ref names and reports the gesture", async () => {
    const page = "<button onclick=\"document.title = 'clicked ' + event.isTrusted\">Go</button>";
    await call("browser_navigate", { url: `data:text/html,${encodeURIComponent(page)}` });
    const snapshot = (await call("browser_snapshot", {})).content[0].text;
    const ref = /button "Go".*\[ref=(e\d+)\]/.exec(snapshot)![1];

    const clicked = await call("browser_click", { target: ref });
    expect(clicked.content[0].text).toContain("Page Title: clicked true");
    expect(clicked._meta.aperture.gesture).toMatchObject({
      tool: "browser_click",
      fallback: true,
      hold: 45,
    });

    const missing = await call("browser_click", { target: "e999" });
    expect(missing.isError).toBe(true);
  });
});
