import { expect } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { Attached, Cdp } from "../src/cdp.ts";
import * as Runner from "../src/runner.ts";
import * as Site from "../src/site.ts";
import { suite } from "../src/suite.ts";
import { until } from "../src/wait.ts";

// What a state carries beside cookies, local storage and databases: an origin's caches and
// private files, what it stores while it is embedded in a page of another site, and the
// tabs that were open, each with what its document had.

const NO_ICON = '<link rel="icon" href="data:,">';

const PLAIN_PAGE = `${NO_ICON}<title>plain</title>`;

/** A page with what a person fills in, which notes what its own script found as it started. */
const FORM_PAGE = `${NO_ICON}<title>form</title>
<script>window.early = { name: window.name, step: sessionStorage.getItem('step') };</script>
<input id="q" name="q">
<textarea id="t"></textarea>
<select id="s"><option>a</option><option>b</option></select>
<input type="checkbox" id="c">
<div id="box" style="height: 100px; overflow: auto"><div style="height: 2000px"></div></div>
<div id="e" contenteditable>plain</div>
<div style="height: 5000px"></div>`;

/** What someone does on the form's page. */
const FILL_THE_FORM = `(() => {
  window.name = 'main';
  sessionStorage.setItem('step', '2');
  history.replaceState({ at: new Date(86400000), n: 5n }, '');
  document.querySelector('#q').value = 'typed';
  document.querySelector('#t').value = 'two\\nlines';
  document.querySelector('#s').selectedIndex = 1;
  document.querySelector('#c').checked = true;
  document.querySelector('#e').innerHTML = '<b>bold</b>';
  document.querySelector('#box').scrollTop = 150;
  document.querySelector('#t').focus();
  document.querySelector('#t').setSelectionRange(1, 3);
  scrollTo(0, 400);
})()`;

const WHAT_THE_FORM_HAS = `({
  early: window.early,
  name: window.name,
  step: sessionStorage.getItem('step'),
  state: history.state && {
    at: history.state.at instanceof Date && history.state.at.getTime(),
    n: typeof history.state.n === 'bigint' && String(history.state.n),
  },
  q: document.querySelector('#q').value,
  t: document.querySelector('#t').value,
  s: document.querySelector('#s').value,
  c: document.querySelector('#c').checked,
  e: document.querySelector('#e').innerHTML,
  box: document.querySelector('#box').scrollTop,
  focused: document.activeElement.id,
  selected: [document.querySelector('#t').selectionStart, document.querySelector('#t').selectionEnd],
  scrolled: scrollY,
})`;

/** Keeps an answer in a cache and files of the origin's own, and says `stored` once kept. */
const STORE_FILES = `(async () => {
  const cache = await caches.open('v1');
  await cache.put('/a.txt', new Response('cached', {
    status: 203,
    headers: { 'content-type': 'text/plain', 'x-kept': '1' },
  }));
  const root = await navigator.storage.getDirectory();
  const notes = await root.getDirectoryHandle('notes', { create: true });
  const file = await notes.getFileHandle('a.txt', { create: true });
  const writing = await file.createWritable();
  await writing.write(new Uint8Array([102, 105, 108, 101, 100, 0, 255]));
  await writing.close();
  await root.getDirectoryHandle('empty', { create: true });
  document.title = 'stored';
})()`;

const WHAT_IS_FILED = `(async () => {
  const kept = await (await caches.open('v1')).match('/a.txt');
  const root = await navigator.storage.getDirectory();
  const file = await (await (await root.getDirectoryHandle('notes')).getFileHandle('a.txt')).getFile();
  const empty = await root.getDirectoryHandle('empty');
  let inEmpty = 0;
  for await (const _ of empty.keys()) inEmpty += 1;
  return {
    cached: kept && [kept.status, kept.headers.get('x-kept'), await kept.text()],
    filed: [...new Uint8Array(await file.arrayBuffer())],
    inEmpty,
  };
})()`;

const Filed = Schema.Struct({
  cached: Schema.Unknown,
  filed: Schema.Unknown,
  inEmpty: Schema.Number,
});

/** What an export tells of an origin, as far as the checks read it. */
const Exported = Schema.Struct({
  origins: Schema.Array(
    Schema.Struct({
      origin: Schema.String,
      cacheStorage: Schema.optional(
        Schema.Array(
          Schema.Struct({
            name: Schema.String,
            entries: Schema.Array(Schema.Struct({ url: Schema.String, status: Schema.Number })),
          }),
        ),
      ),
      opfs: Schema.optional(Schema.Array(Schema.Struct({ path: Schema.String }))),
    }),
  ),
});

/** A tab's document as the session reads it, with what it could not carry. */
const Read = Schema.Struct({
  document: Schema.Record(Schema.String, Schema.Unknown),
  leftOut: Schema.Array(Schema.String),
});

const Listed = Schema.Struct({
  targetInfos: Schema.Array(
    Schema.Struct({
      targetId: Schema.String,
      type: Schema.String,
      url: Schema.String,
      openerId: Schema.optional(Schema.String),
    }),
  ),
});

interface Browsing {
  readonly runner: Runner.RunnerService;
  readonly cdp: Cdp;
  /** The tab the session started with. */
  readonly page: Attached;
  readonly open: (url: string, titled: string) => Effect.Effect<void, unknown>;
}

interface StageService {
  readonly site: Site.Site;
  /** The same site by another name, which makes it another site to a browser. */
  readonly other: string;
  /** What reads and writes a tab's document in a page, as an expression. */
  readonly documents: string;
  readonly source: Browsing;
  readonly files: Browsing;
  readonly tabs: Browsing;
  readonly embedded: Browsing;
}

class Stage extends Context.Service<Stage, StageService>()("@aperture-browser/e2e/TabsStage") {}

const browsing = Effect.gen(function* () {
  const runner = yield* Runner.start({
    features: ["cdp"],
    args: ["--egress-allow", "127.0.0.1", "--egress-allow", "::1"],
  });
  const cdp = yield* runner.cdp;
  const page = yield* cdp.attach((yield* runner.targets)[0]!.id);
  const open: Browsing["open"] = (url, titled) =>
    Effect.gen(function* () {
      yield* page.call("Page.navigate", { url });
      yield* until(
        `${url} being titled ${titled}`,
        page.evaluate(`document.title === ${JSON.stringify(titled)}`),
      );
      yield* until(
        `the session telling its tab is at ${url}`,
        runner.targets.pipe(Effect.map((all) => all.some((target) => target.url === url))),
      );
    });
  return { runner, cdp, page, open } satisfies Browsing;
});

const stage = Layer.effect(
  Stage,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const state = yield* path.fromFileUrl(
      new URL("../../crates/runner/src/live/state/", import.meta.url),
    );
    const stored = yield* fs.readFileString(path.join(state, "stored.js"));
    const document = yield* fs.readFileString(path.join(state, "document.js"));

    let port = 0;
    const site = yield* Site.serve(
      Site.by((request) => {
        switch (request.url) {
          case "/form":
            return Site.html(FORM_PAGE);
          case "/embed":
            return Site.html(
              `${NO_ICON}<title>embed</title><script>onmessage = (said) => { document.title = 'frame:' + said.data; };</script><iframe src="http://localhost:${port}/frame"></iframe>`,
            );
          case "/frame":
            return Site.html(
              `<script>parent.postMessage(String(localStorage.getItem('where')), '*');</script>`,
            );
          case "/top":
            return Site.html(
              `${NO_ICON}<script>document.title = 'top:' + localStorage.getItem('where');</script>`,
            );
          default:
            return Site.html(PLAIN_PAGE);
        }
      }),
    );
    port = site.port;
    const [source, files, tabs, embedded] = yield* Effect.all(
      [browsing, browsing, browsing, browsing],
      { concurrency: "unbounded" },
    );
    return {
      site,
      other: `http://localhost:${site.port}`,
      documents: `(${document})(${stored})`,
      source,
      files,
      tabs,
      embedded,
    } satisfies StageService;
  }),
);

suite(stage)("storage state: caches, files, embedded origins and tabs", (it) => {
  it.effect("an origin's caches and files are given when asked for, and taken", () =>
    Effect.gen(function* () {
      const { site, source, files } = yield* Stage;
      yield* source.open(`${site.url}/plain`, "plain");
      yield* source.page.evaluate(STORE_FILES);
      yield* until("the files being kept", source.page.evaluate("document.title === 'stored'"));

      const without = yield* source.runner.request("POST", "/storage-state", {});
      expect(JSON.stringify(without.body)).not.toContain("cacheStorage");

      const asked = yield* source.runner.request("POST", "/storage-state", {
        cache_storage: true,
        opfs: true,
      });
      expect(asked.status).toBe(200);
      const { origins } = yield* Schema.decodeUnknownEffect(Exported)(asked.body);
      expect(origins).toHaveLength(1);
      expect(origins[0]?.cacheStorage).toEqual([
        { name: "v1", entries: [{ url: `${site.url}/a.txt`, status: 203 }] },
      ]);
      expect(origins[0]?.opfs?.map((file) => file.path).toSorted()).toEqual([
        "empty",
        "notes/a.txt",
      ]);

      const asked_before = site.asked().length;
      const put = yield* files.runner.request("PUT", "/storage-state", asked.body);
      expect(put.status).toBe(204);
      // Nothing is asked of the site for it, and no tab is opened.
      expect(site.asked().length).toBe(asked_before);
      expect(yield* files.runner.targets).toHaveLength(1);

      yield* files.open(`${site.url}/plain`, "plain");
      expect(yield* files.page.evaluate(WHAT_IS_FILED, Filed)).toEqual({
        cached: [203, "1", "cached"],
        filed: [102, 105, 108, 101, 100, 0, 255],
        inEmpty: 0,
      });
    }),
  );

  it.effect("tabs are opened as they were, each with what its document had", () =>
    Effect.gen(function* () {
      const { site, documents, source, tabs } = yield* Stage;
      yield* source.open(`${site.url}/form`, "form");
      yield* source.page.evaluate(FILL_THE_FORM);
      const read = yield* source.page.evaluate(`${documents}.read()`, Read);
      expect(read.leftOut).toEqual([]);
      expect(read.document).toMatchObject({ windowName: "main", scroll: { x: 0, y: 400 } });

      const state = {
        tabs: [
          {
            url: `${site.url}/form`,
            active: true,
            sessionStorage: [{ origin: site.url, entries: [{ name: "step", value: "2" }] }],
            document: read.document,
          },
          { url: `${site.url}/opened`, opener: 0 },
          { url: `${site.url}/beside` },
        ],
      };
      const put = yield* tabs.runner.request("PUT", "/storage-state", state);
      expect(put.status).toBe(204);

      // The tab the session began with showed nothing, and is closed: the session tells
      // of that a moment after its browser did it.
      const open = yield* until(
        "the session telling of the tabs alone",
        tabs.runner.targets.pipe(
          Effect.map((all) =>
            all.length === 3 && all.every((target) => target.url.startsWith(site.url))
              ? all
              : undefined,
          ),
        ),
      );
      expect(open.map((target) => target.url).toSorted()).toEqual([
        `${site.url}/beside`,
        `${site.url}/form`,
        `${site.url}/opened`,
      ]);
      const listed = yield* tabs.cdp.call("Target.getTargets", {}, Listed);
      const at = (path: string) =>
        listed.targetInfos.find((target) => target.url === `${site.url}${path}`)!;
      expect(at("/opened").openerId).toBe(at("/form").targetId);
      expect(at("/beside").openerId).toBeUndefined();

      const form = yield* tabs.cdp.attach(at("/form").targetId);
      expect(yield* form.evaluate(WHAT_THE_FORM_HAS)).toEqual({
        // There before the page's own script ran.
        early: { name: "main", step: "2" },
        name: "main",
        step: "2",
        state: { at: 86400000, n: "5" },
        q: "typed",
        t: "two\nlines",
        s: "b",
        c: true,
        e: "<b>bold</b>",
        box: 150,
        focused: "t",
        selected: [1, 3],
        scrolled: 400,
      });
      const opened = yield* tabs.cdp.attach(at("/opened").targetId);
      expect(yield* opened.evaluate("window.opener !== null && window.name")).toBe("");
      // What a tab's pages were given to start with is given to no page after them.
      expect(yield* form.evaluate("Symbol.for('aperture.state.open') in window")).toBe(false);
    }),
  );

  it.effect(
    "what an origin stores while it is embedded is kept apart from what it stores alone",
    () =>
      Effect.gen(function* () {
        const { site, other, embedded } = yield* Stage;
        const asked_before = site.asked().length;
        const put = yield* embedded.runner.request("PUT", "/storage-state", {
          origins: [
            { origin: other, localStorage: [{ name: "where", value: "alone" }] },
            {
              origin: other,
              ancestorOrigins: [site.url],
              localStorage: [{ name: "where", value: "embedded" }],
            },
          ],
        });
        expect(put.body).toBe("");
        expect(put.status).toBe(204);
        expect(site.asked().length).toBe(asked_before);
        expect(yield* embedded.runner.targets).toHaveLength(1);

        yield* embedded.open(`${site.url}/embed`, "frame:embedded");
        yield* embedded.open(`${other}/top`, "top:alone");
      }),
  );
});
