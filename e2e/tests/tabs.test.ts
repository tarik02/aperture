import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Runner from "../src/runner.ts";
import { suite } from "../src/suite.ts";
import { type Page, ready, snapshot, Viewer } from "../src/viewer.ts";
import * as ViewerLive from "../src/viewer.ts";
import { happens } from "../src/wait.ts";
import { comes } from "../src/workbench.ts";

const session = Layer.mergeAll(Runner.layer({ features: ["cdp"] }), ViewerLive.layer);

/** Whether a toolbar button is off, by its label. */
const disabled = (page: Page, label: string) =>
  page.evaluate(`document.querySelector('button[aria-label="${label}"]')?.disabled`);

/** Failures the session told the page since `listen`. */
const failures = (page: Page) => page.evaluate("JSON.stringify(window.failures)");
const listen = (page: Page) =>
  page.evaluate(
    "(window.failures = [], apertureSession.onFailure((f) => window.failures.push(f)), 1)",
  );

/** Waits until the watched tab shows an address with `part` in it, and `also` holds for it. */
const shows = (page: Page, part: string, also = "true") =>
  happens(
    snapshot(page, `watched?.url.includes(${JSON.stringify(part)}) && (${also})`),
    "20 seconds",
  );

suite(session)("tabs, with two people in the session", (it) => {
  let ada: Page;
  let bob: Page;
  let first: number;
  let second: number;

  it.effect("both watch the first tab, and one holds it", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const viewer = yield* Viewer;
      ada = yield* viewer.open(runner.page({ name: "Ada", fit: "0" }));
      bob = yield* viewer.open(runner.page({ name: "Bob", fit: "0" }));
      yield* ready(ada, 2);
      yield* ready(bob, 2);
      first = yield* snapshot(ada, "s.selected", Schema.Number);
      yield* bob.evaluate(`apertureSession.select(${first})`);
      yield* listen(ada);
      yield* listen(bob);

      // Input is what takes a lease.
      const picture = yield* ada.box("[data-aperture-surface=video]");
      yield* ada.clickAt(picture.x, picture.y);
      const holds = yield* happens(
        snapshot(
          ada,
          `s.presence.held.some((h) => h.tab === ${first} && h.holder === s.presence.you)`,
        ),
      );
      expect(holds).toBe(true);
    }),
  );

  it.effect("a tab someone else holds is reloaded all the same", () =>
    Effect.gen(function* () {
      yield* bob.evaluate("apertureSession.go({ along: 'reload' })");
      yield* Effect.sleep("800 millis");
      expect(yield* failures(bob)).toBe("[]");
      expect(yield* disabled(bob, "Reload")).toBe(false);
      const still = yield* snapshot(
        ada,
        `s.presence.held.some((h) => h.tab === ${first} && h.holder === s.presence.you)`,
      );
      expect(still).toBe(true);
    }),
  );

  it.effect("whoever opens a tab goes to it, and nobody else does", () =>
    Effect.gen(function* () {
      yield* bob.evaluate("apertureSession.newTab()");
      const went = yield* happens(
        bob.evaluate(`apertureSession.getSnapshot().selected !== ${first}`),
      );
      expect(went).toBe(true);
      expect(yield* failures(bob)).toBe("[]");
      yield* Effect.sleep("600 millis");
      expect(yield* snapshot(ada, "s.selected")).toBe(first);
      second = yield* snapshot(bob, "s.selected", Schema.Number);
    }),
  );

  it.effect("a new tab goes nowhere along its history", () =>
    Effect.gen(function* () {
      expect(yield* snapshot(bob, "watched.goesBack")).toBe(false);
      expect(yield* snapshot(bob, "watched.goesForward")).toBe(false);
      expect(yield* disabled(bob, "Back")).toBe(true);
      expect(yield* disabled(bob, "Forward")).toBe(true);
    }),
  );

  it.effect("a page that came after another goes back, and from there forward", () =>
    Effect.gen(function* () {
      yield* bob.evaluate("apertureSession.go({ url: 'https://example.com/' })");
      yield* shows(bob, "example.com");
      yield* bob.evaluate("apertureSession.go({ url: 'https://example.org/' })");
      expect(yield* shows(bob, "example.org", "watched.goesBack")).toBe(true);
      expect(yield* disabled(bob, "Back")).toBe(false);
      expect(yield* disabled(bob, "Forward")).toBe(true);

      yield* bob.evaluate("apertureSession.go({ along: 'back' })");
      expect(yield* shows(bob, "example.com", "watched.goesForward")).toBe(true);
      expect(yield* disabled(bob, "Forward")).toBe(false);
    }),
  );

  it.effect("a tab the page opens takes along who gives the page input, and nobody else", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      yield* bob.evaluate(`apertureSession.select(${first})`);
      yield* ada.evaluate("apertureSession.go({ url: 'https://example.org/?first' })");
      yield* shows(ada, "?first");

      const opener = (yield* runner.targets).find((target) => target.tab === first);
      const cdp = yield* runner.cdp;
      const page = yield* cdp.attach(opener!.id);
      // Away from the page's one link, which a click would follow.
      const picture = yield* ada.box("[data-aperture-surface=video]");
      yield* ada.clickAt(picture.x + 300, picture.y + 200);
      // The click has come once the tab is hers by it.
      yield* comes(
        ada,
        `s.presence.held.some((h) => h.tab === ${first} && h.holder === s.presence.you)`,
      );
      yield* page.evaluate("window.open('https://example.net/', '_blank') && 1");

      const went = yield* happens(
        ada.evaluate(`![${first}, ${second}].includes(apertureSession.getSnapshot().selected)`),
      );
      expect(went).toBe(true);
      yield* Effect.sleep("600 millis");
      expect(yield* snapshot(bob, "s.selected")).toBe(first);
    }),
  );

  it.effect("the pages threw nothing", () =>
    Effect.sync(() => {
      expect(ada.errors()).toEqual([]);
      expect(bob.errors()).toEqual([]);
    }),
  );
});
