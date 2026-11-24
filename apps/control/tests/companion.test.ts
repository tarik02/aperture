import * as Executor from "@aperture-browser/e2e/src/executor.ts";
import { read } from "@aperture-browser/e2e/src/http.ts";
import { directory } from "@aperture-browser/e2e/src/process.ts";
import * as Site from "@aperture-browser/e2e/src/site.ts";
import { suite } from "@aperture-browser/e2e/src/suite.ts";
import * as Viewer from "@aperture-browser/e2e/src/viewer.ts";
import { until } from "@aperture-browser/e2e/src/wait.ts";
import { expect } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { rested, shot, signInWithToken } from "./src/console.ts";
import * as Control from "./src/control.ts";
import { registeredWith } from "./src/node.ts";

// The companion as it is built, `pnpm --filter @aperture-browser/companion build`, loaded
// into a browser of someone's own, with a page of a site that keeps things there; a control
// plane with a node and the console, which is built as well; and the popup pressed as a
// person presses it.

const NO_ICON = '<link rel="icon" href="data:,">';

/** A page that keeps nothing by itself: what it has, someone did there. */
const PAGE = `${NO_ICON}<title>notes</title>
<input id="draft" name="draft">
<div style="height: 4000px"></div>`;

/** What someone does on the page, and `kept` in its title once all of it is kept. */
const USE_THE_PAGE = `(() => {
  localStorage.setItem('theme', 'dark');
  sessionStorage.setItem('step', '2');
  window.name = 'notes-window';
  document.querySelector('#draft').value = 'half a thought';
  scrollTo(0, 300);
  const opening = indexedDB.open('notes', 2);
  opening.onupgradeneeded = () => opening.result.createObjectStore('kept', { keyPath: 'id' });
  opening.onsuccess = () => {
    const writing = opening.result.transaction('kept', 'readwrite');
    writing.objectStore('kept').put({ id: 1, text: 'remember', at: new Date(86400000) });
    writing.oncomplete = () => {
      opening.result.close();
      document.title = 'kept';
    };
  };
})()`;

/** What the page of a session has of what was done on the one it was taken from. */
const WHAT_THE_PAGE_HAS = `new Promise((found) => {
  const opening = indexedDB.open('notes');
  opening.onupgradeneeded = () => found({ record: 'no database' });
  opening.onsuccess = () => {
    const reading = opening.result.transaction('kept').objectStore('kept').get(1);
    reading.onsuccess = () => {
      const record = reading.result;
      found({
        theme: localStorage.getItem('theme'),
        step: sessionStorage.getItem('step'),
        name: window.name,
        draft: document.querySelector('#draft').value,
        scrolled: scrollY,
        record: record && { text: record.text, at: record.at instanceof Date && record.at.getTime() },
      });
    };
  };
})`;

const Has = Schema.Struct({
  theme: Schema.NullOr(Schema.String),
  step: Schema.NullOr(Schema.String),
  name: Schema.String,
  draft: Schema.String,
  scrolled: Schema.Number,
  record: Schema.Unknown,
});

const Targets = Schema.Struct({
  targetInfos: Schema.Array(
    Schema.Struct({ targetId: Schema.String, type: Schema.String, url: Schema.String }),
  ),
});

const SessionTargets = Schema.Array(Schema.Struct({ id: Schema.String, url: Schema.String }));

const Exported = Schema.Struct({
  cookies: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
});

interface StageService {
  readonly site: Site.Site;
  /** The cookies each request to the site's page came with, in order. */
  readonly cookies: () => readonly string[];
}

class Stage extends Context.Service<Stage, StageService>()(
  "@aperture-browser/control/tests/CompanionStage",
) {}

const stage = Layer.effect(
  Stage,
  Effect.gen(function* () {
    const cookies: string[] = [];
    const site = yield* Site.serve(
      Site.by((request) => {
        // Signing in gives a cookie no script of the page reads.
        if (request.url === "/sign-in") {
          return Effect.succeed(
            HttpServerResponse.redirect("/notes", {
              headers: { "set-cookie": "sid=s3cret; Path=/; HttpOnly; Max-Age=3600" },
            }),
          );
        }
        cookies.push(request.headers["cookie"] ?? "");
        return Site.html(PAGE);
      }),
    );
    return { site, cookies: () => cookies } satisfies StageService;
  }),
);

/**
 * The browser with the extension in it. A person lets the extension reach a site when it
 * asks, in a prompt of the browser's own that nothing but a person answers: here the
 * extension is let reach every site from the start, which is all its manifest has more.
 */
const browser = Layer.effect(
  Viewer.Viewer,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const built = yield* path.fromFileUrl(
      new URL("../../../extensions/aperture-companion/dist", import.meta.url),
    );
    const loaded = `${yield* directory}/companion`;
    yield* fs.copy(built, loaded);
    const manifest = `${loaded}/manifest.json`;
    const declared = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
    )(yield* fs.readFileString(manifest));
    yield* fs.writeFileString(
      manifest,
      JSON.stringify({ ...declared, host_permissions: ["<all_urls>"] }),
    );
    return yield* Viewer.startWith([
      `--load-extension=${loaded}`,
      `--disable-extensions-except=${loaded}`,
      // The browser of a release takes no extension from its command line without.
      "--disable-features=DisableLoadExtensionCommandLineSwitch",
    ]);
  }),
);

const needs = Layer.mergeAll(stage, browser).pipe(
  Layer.provideMerge(registeredWith({ APERTURE_EGRESS_ALLOW: "127.0.0.1" })),
  Layer.provideMerge(Control.layer({ console: true })),
);

suite(needs)("the companion, in a browser of someone's own", (it) => {
  let ada: Effect.Success<ReturnType<typeof Control.account>>;
  let worker: string;
  let popup: Viewer.Page;

  const targets = Effect.gen(function* () {
    const viewer = yield* Viewer.Viewer;
    return (yield* viewer.cdp.call("Target.getTargets", {}, Targets)).targetInfos;
  });

  /** Opens the extension's popup over the tab the browser shows, as its button does. */
  const openPopup = Effect.gen(function* () {
    const viewer = yield* Viewer.Viewer;
    const background = yield* viewer.cdp.attach(worker);
    yield* background.evaluate("chrome.action.openPopup()");
    const opened = yield* until(
      "the extension's popup being open",
      targets.pipe(
        Effect.map((all) =>
          all.find((target) => target.type === "page" && target.url.endsWith("/popup.html")),
        ),
      ),
    );
    return yield* viewer.adopt(opened.targetId);
  });

  const says = (text: string) =>
    `[...document.querySelectorAll('button')].find((one) => one.textContent.trim() === ${JSON.stringify(text)})`;

  /**
   * Presses what an expression gives in a page of the browser's own making. A browser
   * nobody looks at gives the popup, and the window it signs in with, less room than what
   * they show is tall, and what is below is scrolled to, as a person does.
   */
  const pressIn = (page: Viewer.Page, element: string) =>
    Effect.gen(function* () {
      yield* page.until(`!!${element}`);
      yield* page.evaluate(`void ${element}.scrollIntoView({ block: "nearest" })`);
      yield* page.clickOn(element);
    });
  const press = (element: string) => Effect.suspend(() => pressIn(popup, element));

  it.effect("someone signs in to a site and uses a page of it", () =>
    Effect.gen(function* () {
      const viewer = yield* Viewer.Viewer;
      const { site, cookies } = yield* Stage;
      worker = (yield* until(
        "the extension's worker being there",
        targets.pipe(Effect.map((all) => all.find((target) => target.type === "service_worker"))),
        "30 seconds",
      )).targetId;

      // The tab the browser came with: the one its window shows.
      const first = (yield* targets).find((target) => target.type === "page");
      const page = yield* viewer.adopt(first!.targetId);
      yield* page.cdp.call("Page.navigate", { url: `${site.url}/sign-in` });
      yield* page.until("document.title === 'notes'");
      yield* page.evaluate(USE_THE_PAGE);
      yield* page.until("document.title === 'kept'");
      // The cookie is the browser's, and none the page's scripts see.
      expect(yield* page.evaluate("document.cookie")).toBe("");
      expect(cookies()).toEqual(["sid=s3cret"]);
    }),
  );

  it.effect("the popup connects to the control plane with an API token", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      ada = yield* Control.account("Ada");
      popup = yield* openPopup;

      const fs = yield* FileSystem.FileSystem;
      yield* shot(popup, fs, "companion-connect");
      yield* press(says("Use API token instead"));
      // The address is offered as the tab's own, which is no control plane's.
      yield* press(`document.querySelector("#origin")`);
      yield* popup.evaluate("document.querySelector('#origin').select()");
      yield* popup.type(control.url);
      yield* press(`document.querySelector("#token")`);
      yield* popup.type(ada.token);
      yield* press(says("Connect with API token"));

      yield* popup.until("!!document.querySelector('#teleport-tabs')", "30 seconds");
      yield* shot(popup, fs, "companion-home");
      expect(yield* popup.text("#teleport-tabs")).toBe("Current tab");
      expect(yield* popup.text("header button")).toContain("Ada");
    }),
  );

  it.effect("a teleport makes a session whose browser has what the tab had", () =>
    Effect.gen(function* () {
      const executor = yield* Executor.Executor;
      const { site, cookies } = yield* Stage;
      yield* press(says("Teleport"));

      const [session] = yield* until(
        "the session being there",
        ada.api.sessions
          .list({ query: {} })
          .pipe(Effect.map((all) => (all.length === 0 ? undefined : all))),
        "90 seconds",
      );
      expect(session).toMatchObject({
        desiredState: "running",
        label: "kept",
        tags: { source: "aperture-companion", action: "teleport" },
      });

      // Its one tab is the page, asked of the site with the cookie that signed in.
      // The empty tab it began with is closed, which it tells of a moment after.
      const tabs = yield* until(
        "the session telling of the page's tab alone",
        executor.session(session!.id, "GET", "/targets").pipe(
          Effect.flatMap((listed) => read(listed, SessionTargets)),
          // It tells of the page's tab a moment after it tells the empty one is gone.
          Effect.map((all) =>
            all.length === 1 && all[0]?.url.startsWith(site.url) ? all : undefined,
          ),
        ),
      );
      expect(tabs.map((tab) => tab.url)).toEqual([`${site.url}/notes`]);
      expect(cookies()).toEqual(["sid=s3cret", "sid=s3cret"]);

      const exported = yield* executor.session(session!.id, "POST", "/storage-state", {});
      expect((yield* read(exported, Exported)).cookies).toEqual([
        expect.objectContaining({ name: "sid", value: "s3cret", httpOnly: true, hostOnly: true }),
      ]);

      const cdp = yield* executor.cdp(session!.id);
      const page = yield* cdp.attach(tabs[0]!.id);
      const has = yield* until(
        "the session's page having what the tab's had",
        page
          .evaluate(WHAT_THE_PAGE_HAS, Has)
          .pipe(
            Effect.map((seen) => (seen.draft === "" || seen.scrolled === 0 ? undefined : seen)),
          ),
        "30 seconds",
      );
      expect(has).toEqual({
        theme: "dark",
        step: "2",
        name: "notes-window",
        draft: "half a thought",
        scrolled: 300,
        record: { text: "remember", at: 86400000 },
      });
    }),
  );

  it.effect("the browser is shown the session, in the console", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const [session] = yield* ada.api.sessions.list({ query: {} });
      yield* until(
        "a tab at the session's page of the console",
        targets.pipe(
          Effect.map((all) =>
            all.some((target) => target.url === `${control.url}/-/sessions/${session!.id}`),
          ),
        ),
      );
    }),
  );

  it.effect("a teleport into a snapshot keeps the state and no session", () =>
    Effect.gen(function* () {
      const viewer = yield* Viewer.Viewer;
      const { site } = yield* Stage;
      // The popup closed when the console was opened; the tab is shown again for the next.
      const tab = (yield* targets).find((target) => target.url === `${site.url}/notes`);
      yield* viewer.cdp.call("Target.activateTarget", { targetId: tab!.targetId });
      const before = yield* ada.api.sessions.list({ query: {} });
      popup = yield* openPopup;
      yield* popup.until("!!document.querySelector('#teleport-tabs')", "30 seconds");
      yield* press(`document.querySelector('[aria-label="Snapshot"]')`);
      yield* press(says("Teleport"));

      const [snapshot] = yield* until(
        "the snapshot being there",
        ada.api.snapshots
          .list({ query: {} })
          .pipe(Effect.map((all) => (all.length === 0 ? undefined : all))),
        "120 seconds",
      );
      expect(snapshot).toMatchObject({ name: "kept", workspaceId: null });
      yield* until(
        "the session it was taken of being deleted",
        ada.api.sessions
          .list({ query: {} })
          .pipe(Effect.map((all) => all.length === before.length)),
        "60 seconds",
      );

      // A session of the snapshot is signed in as the tab was. The console, which the
      // browser was shown at the same host, left a cookie of its own beside the site's.
      const executor = yield* Executor.Executor;
      const made = yield* ada.api.sessions.create({ payload: { snapshotId: snapshot!.id } });
      const exported = yield* executor.session(made.id, "POST", "/storage-state", {
        origins: [site.url],
      });
      expect((yield* read(exported, Exported)).cookies).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "sid", value: "s3cret" })]),
      );
    }),
  );

  it.effect("a snapshot name that is taken is told, and nothing is made", () =>
    Effect.gen(function* () {
      const viewer = yield* Viewer.Viewer;
      const { site } = yield* Stage;
      const tab = (yield* targets).find((target) => target.url === `${site.url}/notes`);
      yield* viewer.cdp.call("Target.activateTarget", { targetId: tab!.targetId });
      const before = yield* ada.api.sessions.list({ query: {} });
      popup = yield* openPopup;
      yield* popup.until("!!document.querySelector('#teleport-tabs')", "30 seconds");
      yield* press(`document.querySelector('[aria-label="Snapshot"]')`);
      yield* press(says("Teleport"));

      // What the popup said of the teleport before is there until this one is told.
      yield* popup.until(
        `document.querySelector('[role="alert"]')?.textContent.includes("exists already")`,
        "60 seconds",
      );
      yield* shot(popup, yield* FileSystem.FileSystem, "companion-name-taken");
      expect(yield* ada.api.snapshots.list({ query: {} })).toHaveLength(1);
      expect(yield* ada.api.sessions.list({ query: {} })).toHaveLength(before.length);
    }),
  );

  /** The tab of the site is the one the browser shows, and the popup is opened over it. */
  const reopened = Effect.gen(function* () {
    const viewer = yield* Viewer.Viewer;
    const { site } = yield* Stage;
    const tab = (yield* targets).find((target) => target.url === `${site.url}/notes`);
    yield* viewer.cdp.call("Target.activateTarget", { targetId: tab!.targetId });
    popup = yield* openPopup;
    yield* popup.until("!!document.querySelector('#teleport-tabs')", "30 seconds");
  });

  const kept = Effect.gen(function* () {
    const viewer = yield* Viewer.Viewer;
    const background = yield* viewer.cdp.attach(worker);
    return yield* background.evaluate(
      `chrome.storage.local.get("apertureConnections").then((kept) => kept.apertureConnections.connections.map((one) => one.oauth === undefined ? "token" : "oauth"))`,
      Schema.Array(Schema.String),
    );
  });

  it.effect("the popup connects through Aperture's own sign-in, as an app a person lets in", () =>
    Effect.gen(function* () {
      const viewer = yield* Viewer.Viewer;
      const control = yield* Control.Control;
      const fs = yield* FileSystem.FileSystem;
      yield* reopened;
      yield* press(`document.querySelector("header button")`);
      yield* press(says("Add connection"));
      yield* press(`document.querySelector("#origin")`);
      yield* popup.evaluate("document.querySelector('#origin').select()");
      yield* popup.type(control.url);
      yield* press(says("Connect with Aperture"));

      // The browser opens a window of its own on the control plane, which sends whoever
      // comes to the console: they sign in there, and are asked what the extension gets.
      const asking = yield* until(
        "the browser's window on the control plane",
        targets.pipe(
          Effect.map((all) =>
            all.find(
              (target) => target.type === "page" && target.url.startsWith(`${control.url}/oauth/`),
            ),
          ),
        ),
        "30 seconds",
      );
      const page = yield* viewer.adopt(asking.targetId);
      // What the sign-in page offers comes as it learns of it, a passkey's button after
      // the rest, and moves what is below: the page is pressed once it stays as it is.
      yield* page.until(`!!document.querySelector("[data-console-sign-in-way]")`, "30 seconds");
      yield* rested(page);
      yield* signInWithToken(page, ada.token);
      yield* page.until(`!!document.querySelector("[data-console-consent-allow]")`, "30 seconds");
      expect(yield* page.text("[data-console-consent]")).toContain("Aperture Companion");
      expect(
        yield* page.evaluate(
          `[...document.querySelectorAll("[data-console-consent] [data-console-scope][data-checked]")].map((one) => one.dataset.consoleScope).toSorted()`,
        ),
      ).toEqual(["sessions:read", "sessions:write", "snapshots:read", "snapshots:write"]);
      yield* shot(page, fs, "companion-consent");
      yield* pressIn(page, `document.querySelector("[data-console-consent-allow]")`);

      // The code it is answered with is exchanged for tokens, which call the API as Ada.
      yield* until(
        "the extension keeping the connection",
        kept.pipe(Effect.map((all) => all.length === 2)),
        "30 seconds",
      );
      expect(yield* kept).toEqual(["token", "oauth"]);
      const [grant] = yield* ada.api.grants.list();
      expect(grant).toMatchObject({
        accountId: ada.account.id,
        clientName: "Aperture Companion",
        resources: null,
      });
      expect(grant?.scopes.toSorted()).toEqual([
        "sessions:read",
        "sessions:write",
        "snapshots:read",
        "snapshots:write",
      ]);
    }),
  );

  it.effect("a teleport goes with the tokens of the grant", () =>
    Effect.gen(function* () {
      const before = yield* ada.api.sessions.list({ query: {} });
      yield* reopened;
      expect(yield* popup.text("header button")).toContain("Ada");
      yield* press(says("Teleport"));
      yield* until(
        "the session being there",
        ada.api.sessions
          .list({ query: {} })
          .pipe(Effect.map((all) => all.length === before.length + 1)),
        "90 seconds",
      );
    }),
  );

  it.effect("removing the connection gives the grant back", () =>
    Effect.gen(function* () {
      yield* reopened;
      yield* press(`document.querySelector("header button")`);
      yield* press(`document.querySelector('[aria-label^="Disconnect"]')`);
      yield* press(says("Disconnect"));
      yield* until(
        "the grant being given back",
        ada.api.grants.list().pipe(Effect.map((all) => all.length === 0)),
        "30 seconds",
      );
      yield* until(
        "the connection being forgotten",
        kept.pipe(Effect.map((all) => all.length === 1)),
      );
      expect(yield* kept).toEqual(["token"]);
    }),
  );
});
