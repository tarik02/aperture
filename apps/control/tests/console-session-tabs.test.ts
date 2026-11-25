import * as Mcp from "@aperture-browser/e2e/src/mcp.ts";
import { suite } from "@aperture-browser/e2e/src/suite.ts";
import * as Viewer from "@aperture-browser/e2e/src/viewer.ts";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Proxy from "./src/proxy.ts";
import { DARK, needs, shot, signInWithToken, withSession } from "./src/console.ts";

/** A page told from the others by its colour and its title. */
const page = (title: string, colour: string) =>
  `data:text/html,<title>${title}</title><body style="margin:0;display:grid;place-items:center;height:100vh;background:%23${colour};color:white;font:bold 64px sans-serif">${title}</body>`;

suite(needs)("a session's tabs in the console's grid", (it) => {
  it.effect("a card stands for each of its session's tabs, and the grid shows them all", () =>
    Effect.gen(function* () {
      const { account: ada, path } = yield* withSession("Ada");
      const proxy = yield* Proxy.Proxy;
      const viewer = yield* Viewer.Viewer;
      const fs = yield* FileSystem.FileSystem;
      const id = path.split("/").at(-1) ?? "";
      yield* ada.api.sessions.describe({
        params: { id },
        payload: { label: "Checkout flow", tags: {} },
      });

      const agent = yield* Mcp.connect(`${proxy.url}${path}`, ada.token);
      yield* agent.call("navigate", { url: page("Cart", "2563eb") });
      yield* agent.call("tabs", { action: "new", url: page("Payment", "16a34a") });
      yield* agent.call("tabs", { action: "new", url: page("Receipt", "c026d3") });

      const view = yield* viewer.open(`${proxy.url}/`);
      yield* signInWithToken(view, ada.token);
      const card = `[data-console-session="${id}"]`;
      yield* view.until(
        `!!document.querySelector('${card} [data-console-session-tabs]')`,
        "30 seconds",
      );
      yield* view.until(
        `document.querySelector(${JSON.stringify(`${card} img`)})?.naturalWidth > 0`,
        "30 seconds",
      );
      expect(yield* view.text(`${card} [data-console-session-tabs]`)).toContain("3");
      yield* shot(view, fs, "console-session-tabs-card");

      yield* view.hover(`${card} [data-console-session-open]`);
      yield* view.until(`!!document.querySelector("[data-console-session-strip]")`, "10 seconds");
      yield* view.until(
        `[...document.querySelectorAll("[data-console-session-strip] img")].every((one) => one.naturalWidth > 0)`,
        "30 seconds",
      );
      yield* shot(view, fs, "console-session-tabs-strip");

      yield* view.click(`[data-console-sessions-view="tabs"]`);
      yield* view.until(
        `document.querySelectorAll("[data-console-tab-card]").length >= 3`,
        "30 seconds",
      );
      yield* view.until(
        `[...document.querySelectorAll("[data-console-tab-card] img")].every((one) => one.naturalWidth > 0)`,
        "30 seconds",
      );
      yield* shot(view, fs, "console-session-tabs-view");
      yield* view.click(`[aria-label="Search tabs"]`);
      yield* view.type("pay");
      yield* view.until(
        `document.querySelectorAll("[data-console-tab-card]").length === 1`,
        "10 seconds",
      );
      yield* shot(view, fs, "console-session-tabs-search");

      yield* ada.api.sessions.suspend({ params: { id } });
      yield* view.evaluate(`void (location.href = "/-/sessions")`);
      yield* view.until(
        `!!document.querySelector('${card} [data-console-session-tabs]') && document.querySelector(${JSON.stringify(`${card} img`)})?.naturalWidth > 0`,
        "60 seconds",
      );
      yield* shot(view, fs, "console-session-tabs-suspended");
      yield* view.hover(`${card} [data-console-session-open]`);
      yield* view.until(
        `[...document.querySelectorAll("[data-console-session-strip] img")].length >= 3 && [...document.querySelectorAll("[data-console-session-strip] img")].every((one) => one.naturalWidth > 0)`,
        "30 seconds",
      );
      yield* shot(view, fs, "console-session-tabs-suspended-strip");

      yield* view.evaluate(`void (location.href = "/-/sessions?view=tabs")`);
      yield* view.until(`!!document.querySelector("[data-console-tab-card]")`, "30 seconds");
      yield* view.evaluate(DARK);
      yield* view.until(
        `[...document.querySelectorAll("[data-console-tab-card] img")].length >= 3 && [...document.querySelectorAll("[data-console-tab-card] img")].every((one) => one.naturalWidth > 0)`,
        "30 seconds",
      );
      yield* shot(view, fs, "console-session-tabs-view-dark");
      yield* view.close;
    }),
  );
});
