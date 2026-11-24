import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Mcp from "../src/mcp.ts";
import { directory } from "../src/process.ts";
import * as Runner from "../src/runner.ts";
import * as Site from "../src/site.ts";
import { suite } from "../src/suite.ts";
import { type Page, ready, Viewer } from "../src/viewer.ts";
import * as ViewerLive from "../src/viewer.ts";
import { happens } from "../src/wait.ts";
import {
  appears,
  buttonWithin,
  chooseFiles,
  clickElement,
  clickPicture,
  comes,
  dataPage,
  escape,
  EVERY_FEATURE,
  has,
  inTab,
  keepErrors,
  leaves,
  loggedErrors,
  openByAutomation,
  selectTab,
} from "../src/workbench.ts";

const session = Layer.mergeAll(
  // The downloads come from a site on this machine.
  Runner.layer({ features: EVERY_FEATURE, args: ["--egress-allow", "127.0.0.1"] }),
  ViewerLive.layer,
);

const ASKING = dataPage(`
  <title>Files check</title>
  <body style="margin:0">
    <input id="one" type="file" style="position:absolute;left:100px;top:400px;font-size:30px">
    <input id="several" type="file" multiple style="position:absolute;left:100px;top:500px;font-size:30px">
  </body>
`);

/** Points on the buttons of the page's two file inputs, in the tab's logical pixels. */
const ASKS_FOR_ONE = { x: 180, y: 420 };
const ASKS_FOR_SEVERAL = { x: 180, y: 520 };

const PANEL = "[data-session-files]";
const REQUEST = "[data-session-file-request]";
const upload = (name: string) => `[data-session-upload="${name}"]`;
const download = (name: string) => `[data-session-download="${name}"]`;

const HALTED_AT = 380;
const HALTED_OF = 1000;

const attached = (name: string, bytes: number) => ({
  contentType: "application/octet-stream",
  contentLength: bytes,
  headers: { "Content-Disposition": `attachment; filename="${name}"` },
});

const sent = (text: string) => Stream.make(new TextEncoder().encode(text));

/**
 * A site of three files to download: one that comes whole, one that halts on the way for
 * as long as the site lasts, and one whose connection breaks.
 */
const downloads = Site.by((request) => {
  switch (request.url) {
    case "/whole": {
      return Effect.succeed(
        HttpServerResponse.stream(sent("paid\n"), attached("invoice.txt", "paid\n".length)),
      );
    }
    case "/halting": {
      return Effect.succeed(
        HttpServerResponse.stream(
          Stream.concat(sent("x".repeat(HALTED_AT)), Stream.never),
          attached("export.csv", HALTED_OF),
        ),
      );
    }
    case "/breaking": {
      // The answer ends short of the length it told, and its connection with it.
      const broken = attached("broken.zip", HALTED_OF);
      return Effect.succeed(
        HttpServerResponse.stream(sent("x".repeat(10)), {
          ...broken,
          headers: { ...broken.headers, Connection: "close" },
        }),
      );
    }
    default: {
      return Effect.succeed(HttpServerResponse.empty({ status: 404 }));
    }
  }
});

/** Puts a file of this machine into the session through the panel's own input. */
const uploadThroughPanel = (page: Page, name: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* directory;
    yield* fs.writeFileString(`${dir}/${name}`, content);
    yield* chooseFiles(page, "[data-session-file-input]", [`${dir}/${name}`]);
    return yield* appears(page, upload(name));
  });

/** Has the page tell later whether the panel ever showed an upload on its way. */
const watchForProgress = (page: Page) =>
  page.evaluate(
    `(() => {
      window.__progressShown = false;
      const look = () => {
        if (document.querySelector("[data-session-upload-progress]")) {
          window.__progressShown = true;
        }
      };
      new MutationObserver(look).observe(document.body, { childList: true, subtree: true });
      look();
    })()`,
  );

const openPanel = (page: Page) =>
  Effect.gen(function* () {
    if (!(yield* has(page, PANEL))) {
      yield* page.click("[data-session-files-button]");
    }
    yield* page.until(`!!document.querySelector("${PANEL}")`);
  });

const namesGiven = (mcp: Mcp.Mcp, tab: number, input: string) =>
  inTab(mcp, tab, `[...document.getElementById('${input}').files].map((file) => file.name)`);

suite(session)("the workbench's files", (it) => {
  let page: Page;
  let mcp: Mcp.Mcp;
  let asking: number;

  it.effect("a file chosen in the files panel is uploaded and listed", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const viewer = yield* Viewer;
      mcp = yield* Mcp.connect(runner.url, runner.token);
      page = yield* viewer.open(runner.page(), { scheme: "light" });
      yield* ready(page);
      yield* keepErrors(page);
      asking = yield* openByAutomation(mcp, ASKING);
      yield* page.until(`!!document.querySelector('[data-browser-tab][data-tab="${asking}"]')`);
      expect(yield* selectTab(page, asking)).toBe(true);
      yield* page.until("document.querySelector('[data-aperture-surface=video]').videoWidth > 0");

      yield* openPanel(page);
      expect(yield* uploadThroughPanel(page, "passport.txt", "a passport\n")).toBe(true);
      const kept = yield* page.evaluate(
        "apertureSession.uploads().then((uploads) => uploads.map((file) => file.name))",
      );
      expect(kept).toContain("passport.txt");
      yield* escape(page);
      expect(yield* leaves(page, PANEL)).toBe(true);
    }),
  );

  it.effect("a page that asks for a file opens the panel by itself, and an upload answers", () =>
    Effect.gen(function* () {
      yield* clickPicture(page, ASKS_FOR_ONE.x, ASKS_FOR_ONE.y);
      expect(yield* comes(page, `s.fileRequests.some((asked) => asked.tab === ${asking})`)).toBe(
        true,
      );
      expect(yield* appears(page, REQUEST)).toBe(true);

      yield* page.click(upload("passport.txt"));
      yield* clickElement(page, buttonWithin(REQUEST, "Give the file"));
      expect(yield* comes(page, "s.fileRequests.length === 0")).toBe(true);
      const given = yield* happens(
        namesGiven(mcp, asking, "one").pipe(
          Effect.map((names) => JSON.stringify(names) === '["passport.txt"]'),
        ),
      );
      expect(given).toBe(true);
      yield* escape(page);
      yield* leaves(page, PANEL);
    }),
  );

  it.effect("a request that is cancelled goes", () =>
    Effect.gen(function* () {
      yield* clickPicture(page, ASKS_FOR_ONE.x, ASKS_FOR_ONE.y);
      expect(yield* comes(page, `s.fileRequests.some((asked) => asked.tab === ${asking})`)).toBe(
        true,
      );
      yield* page.until(`!!document.querySelector("${REQUEST}")`);
      yield* clickElement(page, buttonWithin(REQUEST, "Cancel"));
      expect(yield* comes(page, "s.fileRequests.length === 0")).toBe(true);
    }),
  );

  it.effect("a page that asks for several files is given the uploads picked", () =>
    Effect.gen(function* () {
      yield* openPanel(page);
      expect(yield* uploadThroughPanel(page, "notes.txt", "some notes\n")).toBe(true);
      yield* escape(page);
      yield* leaves(page, PANEL);

      yield* clickPicture(page, ASKS_FOR_SEVERAL.x, ASKS_FOR_SEVERAL.y);
      expect(yield* appears(page, REQUEST)).toBe(true);
      yield* page.click(upload("passport.txt"));
      yield* page.click(upload("notes.txt"));
      yield* clickElement(page, buttonWithin(REQUEST, "Give 2 files"));
      expect(yield* comes(page, "s.fileRequests.length === 0")).toBe(true);
      const given = yield* happens(
        namesGiven(mcp, asking, "several").pipe(
          Effect.map((names) => JSON.stringify(names) === '["passport.txt","notes.txt"]'),
        ),
      );
      expect(given, JSON.stringify(yield* namesGiven(mcp, asking, "several"))).toBe(true);
    }),
  );

  it.effect("an upload is removed by its button", () =>
    Effect.gen(function* () {
      yield* openPanel(page);
      yield* page.click('[aria-label="Remove passport.txt"]');
      expect(yield* leaves(page, upload("passport.txt"))).toBe(true);
      const kept = yield* page.evaluate(
        "apertureSession.uploads().then((uploads) => uploads.map((file) => file.name))",
      );
      expect(kept).not.toContain("passport.txt");
    }),
  );

  it.effect("an upload shows how far it is while it goes", () =>
    Effect.gen(function* () {
      yield* openPanel(page);
      yield* watchForProgress(page);
      // Large enough to be on its way for longer than the panel takes to show it.
      const uploaded = yield* uploadThroughPanel(page, "large.bin", "x".repeat(48 * 1024 * 1024));
      expect(uploaded).toBe(true);
      expect(yield* page.evaluate("window.__progressShown")).toBe(true);
      yield* escape(page);
      yield* leaves(page, PANEL);
    }),
  );

  it.effect("downloads are told as they go: done as a link, how far, and failed", () =>
    Effect.gen(function* () {
      const site = yield* Site.serve(downloads);
      for (const path of ["/whole", "/halting", "/breaking"]) {
        yield* page.evaluate(`apertureSession.go({ url: "${site.url}${path}" })`);
        yield* happens(Effect.sync(() => site.asked().includes(path)));
      }
      expect(yield* appears(page, `${download("invoice.txt")}[data-state=done]`)).toBe(true);
      yield* openPanel(page);

      const link = yield* page.evaluate(
        `document.querySelector('${download("invoice.txt")} a').href`,
        Schema.String,
      );
      expect(new URL(link).pathname).toBe("/files/downloads/invoice.txt");
      const served = yield* page.evaluate(
        `fetch(${JSON.stringify(link)}).then(async (answer) => [answer.status, await answer.text()])`,
      );
      expect(served).toEqual([200, "paid\n"]);

      const percent = `${Math.round((100 * HALTED_AT) / HALTED_OF)}%`;
      const running = yield* happens(
        page
          .text(download("export.csv"))
          .pipe(Effect.map((text) => text?.includes(percent) === true)),
      );
      expect(running, yield* page.text(download("export.csv"))).toBe(true);

      const failed = yield* happens(
        page
          .text(`${download("broken.zip")}[data-state=failed]`)
          .pipe(Effect.map((text) => text?.includes("Failed") === true)),
      );
      expect(failed, yield* page.text(PANEL)).toBe(true);
      yield* escape(page);
    }),
  );

  it.effect("the page threw nothing and logged no error", () =>
    Effect.gen(function* () {
      expect(page.errors()).toEqual([]);
      expect(yield* loggedErrors(page)).toEqual([]);
    }),
  );
});
