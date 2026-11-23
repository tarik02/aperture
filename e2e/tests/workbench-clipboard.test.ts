import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Mcp from "../src/mcp.ts";
import * as Runner from "../src/runner.ts";
import * as Site from "../src/site.ts";
import { suite } from "../src/suite.ts";
import * as Tickets from "../src/tickets.ts";
import { type Page, ready, Viewer } from "../src/viewer.ts";
import * as ViewerLive from "../src/viewer.ts";
import { happens, until } from "../src/wait.ts";
import {
  clickElement,
  clickPicture,
  comes,
  dataPage,
  EVERY_FEATURE,
  inTab,
  keepErrors,
  loggedErrors,
  openByAutomation,
  pictureKeepsUp,
  selectTab,
} from "../src/workbench.ts";

const session = Layer.mergeAll(
  // The page that copies is of a site on this machine.
  Tickets.layer({ features: EVERY_FEATURE, args: ["--egress-allow", "127.0.0.1"] }),
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

/** A page that is one field, for what is pasted to land in. */
const FIELD = dataPage(
  `<title>Paste check</title><textarea id="into" style="position:fixed;inset:0;width:100%;height:100%"></textarea>`,
);
const WRITTEN = "document.getElementById('into').value";

/**
 * Has a page take a paste of text where its keyboard is, as its browser gives one, and
 * tells whether that is where the session's keys are taken.
 */
const paste = (page: Page, text: string) =>
  page.evaluate(
    `(() => {
      const carried = new DataTransfer();
      carried.setData("text/plain", ${JSON.stringify(text)});
      const into = document.activeElement;
      into.dispatchEvent(new ClipboardEvent("paste", { clipboardData: carried, bubbles: true, cancelable: true }));
      return into.matches("[data-aperture-surface=keys]");
    })()`,
    Schema.Boolean,
  );

const noticed = (page: Page) => happens(page.evaluate(`!!(${NOTICE})`, Schema.Boolean));

suite(session)("what the session copied, where this browser's clipboard refuses it", (it) => {
  let page: Page;
  let mcp: Mcp.Mcp;
  let site: Site.Site;
  let tab: number;
  let field: number;

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
      // What shows the notices takes two more frames to be done with one that went, and
      // takes the next one of its kind for the same notice until then: it goes with it.
      yield* page.evaluate(
        "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))",
      );
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

  it.effect("what is pasted here is pasted into the page the session shows", () =>
    Effect.gen(function* () {
      field = yield* openByAutomation(mcp, FIELD);
      yield* page.until(`!!document.querySelector('[data-browser-tab][data-tab="${field}"]')`);
      expect(yield* selectTab(page, field)).toBe(true);
      yield* pictureKeepsUp(page);
      yield* clickPicture(page, 100, 100);
      yield* until(
        "the field having the session's keyboard",
        inTab(mcp, field, "document.activeElement?.id === 'into'"),
      );
      expect(yield* paste(page, "pasted from here")).toBe(true);
      yield* until(
        "what was pasted being in the field",
        inTab(mcp, field, WRITTEN).pipe(Effect.map((written) => written === "pasted from here")),
      );
    }),
  );

  it.effect("and nothing of whoever may not write the session's clipboard", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const tickets = yield* Tickets.Tickets;
      const viewer = yield* Viewer;
      const ticket = yield* tickets.ticket({ input: "w", tabs: "w" }, { sub: "bob", name: "Bob" });
      const bob = yield* viewer.open(runner.page({ token: ticket, fit: "0" }));
      yield* ready(bob);
      expect(yield* selectTab(bob, field)).toBe(true);
      yield* inTab(mcp, field, `(document.getElementById('into').value = "", true)`);
      // A tab is its holder's for a while after their last input: Bob is let have it.
      yield* page.evaluate("apertureSession.lease('release')");
      yield* pictureKeepsUp(bob);
      yield* clickPicture(bob, 100, 100);
      expect(yield* comes(bob, "s.presence.held.some((h) => h.holder === s.presence.you)")).toBe(
        true,
      );
      yield* bob.type("a");
      yield* until(
        "Bob's key being in the field",
        inTab(mcp, field, WRITTEN).pipe(Effect.map((written) => written === "a")),
      );
      expect(yield* paste(bob, "pasted by Bob")).toBe(true);
      yield* bob.type("z");
      const written = yield* until(
        "the key after the paste being in the field",
        inTab(mcp, field, WRITTEN).pipe(
          Effect.map((now) => typeof now === "string" && now.endsWith("z") && now),
        ),
      );
      // The keys that paste are his to press, as any key is, and paste what the session
      // had to paste: what he carried is not put there for them.
      expect(written).toBe("apasted from herez");
      expect(bob.errors()).toEqual([]);
      yield* bob.close;
    }),
  );

  it.effect("the page threw nothing and logged no error", () =>
    Effect.gen(function* () {
      expect(page.errors()).toEqual([]);
      expect(yield* loggedErrors(page)).toEqual([]);
    }),
  );
});
