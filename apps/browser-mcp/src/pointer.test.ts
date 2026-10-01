import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { Page } from "playwright-core";
import { compositorDevice, Pointer, type ClickOptions, type Surface } from "./pointer.ts";

// A stand-in compositor control socket: records each command and answers "ok",
// or "error" for the commands `reject` matches.
let dir: string;
let server: net.Server;
let commands: string[];
let reject: RegExp | undefined;
let socket: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "weston-"));
  socket = join(dir, "control");
  commands = [];
  reject = undefined;
  server = net.createServer((connection) => {
    connection.on("data", (data) => {
      const command = data.toString().trim();
      commands.push(command);
      connection.end(reject?.test(command) ? "error refused\n" : "ok\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
});

afterEach(() => {
  server.close();
  rmSync(dir, { recursive: true });
});

const options: ClickOptions = {
  button: "left",
  count: 1,
  modifiers: [],
  holdMs: 0,
  motion: "instant",
};

const pointerOn = (surface: Surface, viewport: { width: number; height: number } = surface) =>
  new Pointer(compositorDevice(socket, surface, {} as Page), surface, viewport);

describe("Pointer on a compositor", () => {
  it("scales CSS pixels to the surface and clamps to its last pixel", async () => {
    const pointer = pointerOn({ id: 7, width: 200, height: 100 }, { width: 100, height: 50 });
    await pointer.click({ x: 10, y: 20 }, options);
    await pointer.click({ x: 500, y: 500 }, options);
    expect(commands).toContain("button-at 7 20.000 40.000 272 1");
    expect(commands).toContain("button-at 7 199.000 99.000 272 1");
  });

  it("clicks with the requested button, count and modifiers, releasing everything in reverse", async () => {
    const pointer = pointerOn({ id: 1, width: 100, height: 100 });
    await pointer.click(
      { x: 5, y: 5 },
      { ...options, button: "right", count: 2, modifiers: ["Shift", "Control"] },
    );
    expect(commands.slice(commands.indexOf("key 1 42 1"))).toEqual([
      "key 1 42 1",
      "key 1 29 1",
      "button-at 1 5.000 5.000 273 1",
      "button 1 273 0",
      "button-at 1 5.000 5.000 273 1",
      "button 1 273 0",
      "key 1 29 0",
      "key 1 42 0",
    ]);
    expect(pointer.record.clicks.map((click) => click.count)).toEqual([1, 2]);
  });

  it("releases the button and modifiers when pressing fails", async () => {
    reject = /^button-at/;
    const pointer = pointerOn({ id: 1, width: 100, height: 100 });
    await expect(pointer.click({ x: 5, y: 5 }, { ...options, modifiers: ["Alt"] })).rejects.toThrow(
      "rejected",
    );
    expect(commands.at(-1)).toBe("key 1 56 0");
  });

  it("nudges before an instant drag so HTML5 drag and drop starts, then releases without coordinates", async () => {
    const pointer = pointerOn({ id: 1, width: 100, height: 100 });
    await pointer.drag({ x: 10, y: 10 }, { x: 60, y: 10 }, { holdMs: 0, motion: "instant" });
    const press = commands.findIndex((command) => command.startsWith("button-at"));
    expect(commands.slice(press + 1)).toEqual([
      "motion 1 16.000 10.000",
      "motion 1 60.000 10.000",
      "button 1 272 0",
    ]);
  });
});
