import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Mcp from "../src/mcp.ts";
import * as Runner from "../src/runner.ts";
import * as Site from "../src/site.ts";
import { suite } from "../src/suite.ts";
import { type Page, ready, Viewer } from "../src/viewer.ts";
import * as ViewerLive from "../src/viewer.ts";
import { happens } from "../src/wait.ts";
import {
  clickElement,
  EVERY_FEATURE,
  inTab,
  keepErrors,
  loggedErrors,
  openByAutomation,
  selectTab,
} from "../src/workbench.ts";

const session = Layer.mergeAll(
  // The page that copies is of a site on this machine.
  Runner.layer({ features: EVERY_FEATURE, args: ["--egress-allow", "127.0.0.1"] }),
  ViewerLive.layer,
);

/** What a page of the session would have run as whoever watches it. */
const RUN = `opener.document.title = "ran as who watches"`;

const MARKED = `<p>what was <b>copied</b></p><script>${RUN}</script><img src="x" onerror='${RUN}'>`;

const DRAWING = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20">
  <rect width="40" height="20" fill="#f00"/>
  <script>${RUN}</script>
</svg>`;

/** A site whose page copies marked-up text alone, and shows a drawing that carries script. */
const copying = Site.by((request) =>
  request.url === "/drawing.svg"
    ? Effect.succeed(HttpServerResponse.text(DRAWING, { contentType: "image/svg+xml" }))
    : Site.html(`
        <title>Clipboard check</title>
        <p id="words">words to select</p>
        <img src="/drawing.svg">
        <script>
          document.addEventListener("copy", (event) => {
            event.clipboardData.setData("text/html", ${JSON.stringify(MARKED).replaceAll("</", "<\\/")});
            event.preventDefault();
          });
        </script>
      `),
);

/** The notice that offers what the session copied, among the notices there are. */
const NOTICE = `[...document.querySelectorAll("[data-sonner-toast]")].find((one) => one.textContent.includes("The session copied something"))`;
const ACTION = `${NOTICE}?.querySelector("[data-button]")`;

/**
 * Has this browser refuse what a page writes to its clipboard without a click, and keeps
 * what the page opens.
 */
const refuseClipboard = (page: Page) =>
  page.evaluate(
    `(() => {
      const refuse = () => Promise.reject(new DOMException("refused", "NotAllowedError"));
      navigator.clipboard.write = refuse;
      navigator.clipboard.writeText = refuse;
      window.__opened = [];
      const open = window.open;
      window.open = (url, ...rest) => {
        window.__opened.push(String(url));
        return open.call(window, url, ...rest);
      };
    })()`,
  );

/** The kinds of what the page opened, each as its address says it. */
const opened = (page: Page) =>
  page.evaluate(
    `Promise.all(window.__opened.map((url) => fetch(url).then((had) => had.blob()).then((blob) => blob.type)))`,
    Schema.Array(Schema.String),
  );

const noticed = (page: Page) => happens(page.evaluate(`!!(${NOTICE})`, Schema.Boolean));

suite(session)("what the session copied, where this browser's clipboard refuses it", (it) => {
  let page: Page;
  let mcp: Mcp.Mcp;
  let site: Site.Site;
  let tab: number;

  it.effect("marked-up text is copied as text, and is no document here", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const viewer = yield* Viewer;
      site = yield* Site.serve(copying);
      mcp = yield* Mcp.connect(runner.url, runner.token);
      page = yield* viewer.open(runner.page(), { scheme: "light" });
      yield* ready(page);
      yield* keepErrors(page);
      tab = yield* openByAutomation(mcp, site.url);
      yield* page.until(`!!document.querySelector('[data-browser-tab][data-tab="${tab}"]')`);
      expect(yield* selectTab(page, tab)).toBe(true);
      yield* refuseClipboard(page);

      yield* inTab(
        mcp,
        tab,
        "(getSelection().selectAllChildren(document.getElementById('words')), true)",
      );
      yield* page.evaluate("apertureSession.copySelection()");
      expect(yield* noticed(page)).toBe(true);
      yield* clickElement(page, ACTION);

      const copied = yield* happens(
        page
          .evaluate("navigator.clipboard.readText()")
          .pipe(Effect.map((text) => text === "what was copied")),
      );
      expect(copied).toBe(true);
      // As marked-up text too, for what is pasted into: it is text there, and runs nothing.
      const marked = yield* page.evaluate(
        `navigator.clipboard.read().then((items) => items[0].getType("text/html")).then((blob) => blob.text())`,
        Schema.String,
      );
      expect(marked).toContain("<b>copied</b>");
      expect(yield* opened(page)).toEqual([]);
      expect(yield* page.evaluate("document.title", Schema.String)).not.toBe("ran as who watches");
      // The notice goes once what it offered is done.
      expect(yield* happens(page.evaluate(`!(${NOTICE})`, Schema.Boolean))).toBe(true);
    }),
  );

  it.effect("a drawing is opened as the picture it draws, and runs nothing here", () =>
    Effect.gen(function* () {
      yield* page.evaluate(`apertureSession.copyPicture("${site.url}/drawing.svg")`);
      expect(yield* noticed(page)).toBe(true);
      yield* clickElement(page, ACTION);

      expect(yield* happens(opened(page).pipe(Effect.map((kinds) => kinds.length > 0)))).toBe(true);
      expect(yield* opened(page)).toEqual(["image/png"]);
      // Long enough for what was opened to have run what it carried.
      yield* Effect.sleep("1 second");
      expect(yield* page.evaluate("document.title", Schema.String)).not.toBe("ran as who watches");
    }),
  );

  it.effect("the page threw nothing and logged no error", () =>
    Effect.gen(function* () {
      expect(page.errors()).toEqual([]);
      expect(yield* loggedErrors(page)).toEqual([]);
    }),
  );
});
