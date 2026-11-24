import { expect } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Mcp from "../src/mcp.ts";
import * as Runner from "../src/runner.ts";
import * as Site from "../src/site.ts";
import { suite } from "../src/suite.ts";
import { type Page, ready, snapshot, Viewer } from "../src/viewer.ts";
import * as ViewerLive from "../src/viewer.ts";
import { until } from "../src/wait.ts";
import { clickPicture, comes, pictureKeepsUp } from "../src/workbench.ts";

/** A site that tells each page what the page was asked for with. */
class Echo extends Context.Service<Echo, Site.Site>()("@aperture-browser/e2e/page-mode/Echo") {}

/** The site's icon: a picture of one pixel. */
const ICON = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  ),
  (letter) => letter.charCodeAt(0),
);

/** A page whose head waits on a script the site is slow to give, before it names its icon. */
const LATE = `<!doctype html><title>late</title><script src="/slow.js"></script><link rel="icon" href="/icon.png">`;
const SLOW = "1500 millis";

const echo = Site.by((request) =>
  request.url === "/icon.png"
    ? Effect.succeed(HttpServerResponse.uint8Array(ICON, { contentType: "image/png" }))
    : request.url === "/slow.js"
      ? Effect.as(
          Effect.sleep(SLOW),
          HttpServerResponse.text("", { contentType: "text/javascript" }),
        )
      : request.url === "/late"
        ? Site.html(LATE)
        : Site.html(`<!doctype html>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="icon" href="/icon.png">
    <title>seen</title>
    <body style="margin:0;height:3000px">
    <script>
      window.asked = ${JSON.stringify({ ...request.headers })};
      window.got = [];
      window.first = navigator.platform;
      for (const kind of ["touchstart", "click"]) addEventListener(kind, () => got.push(kind), true);
    </script>
    </body>`),
);

const session = Layer.mergeAll(
  Runner.layer({ features: ["cdp", "mcp"], args: ["--egress-allow", "127.0.0.1"] }),
  ViewerLive.layer,
  Layer.effect(Echo, Site.serve(echo)),
);

/** What a page says of what it is shown on. */
const Said = Schema.Struct({
  agent: Schema.String,
  /** As the page's own script read it when the page came. */
  first: Schema.String,
  platform: Schema.String,
  mobile: Schema.Boolean,
  system: Schema.String,
  brands: Schema.String,
  versions: Schema.String,
  forms: Schema.String,
  touches: Schema.Number,
  coarse: Schema.Boolean,
  width: Schema.Number,
  loaded: Schema.Number,
  asked: Schema.Record(Schema.String, Schema.String),
  got: Schema.Array(Schema.String),
});

const SAYS = `(async () => {
  const told = await navigator.userAgentData.getHighEntropyValues(["fullVersionList", "formFactors"]);
  return {
    agent: navigator.userAgent,
    first: window.first ?? "",
    platform: navigator.platform,
    mobile: navigator.userAgentData.mobile,
    system: navigator.userAgentData.platform,
    brands: JSON.stringify(navigator.userAgentData.brands),
    versions: JSON.stringify(told.fullVersionList),
    forms: JSON.stringify(told.formFactors),
    touches: navigator.maxTouchPoints,
    coarse: matchMedia("(pointer: coarse)").matches,
    width: innerWidth,
    loaded: performance.timeOrigin,
    asked: window.asked ?? {},
    got: window.got ?? [],
  };
})()`;

/** What the page of a tab says, asked through the session's DevTools. */
const says = (tab: number) =>
  Effect.gen(function* () {
    const runner = yield* Runner.Runner;
    const cdp = yield* runner.cdp;
    const target = (yield* runner.targets).find((one) => one.tab === tab);
    const page = yield* cdp.attach(target?.id ?? "");
    return yield* page.evaluate(SAYS, Said);
  }).pipe(Effect.scoped);

/** The version of the browser a user agent names. */
const version = (agent: string) => /Chrome\/([\d.]+)/u.exec(agent)?.[1];

/** A tab as the automation lists it. */
const Listed = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ tab: Schema.Number, mode: Schema.String, mobile: Schema.Boolean })),
);

const PNG_WIDTH_AT = 16;

suite(session)("how a tab's pages are shown, with a desktop, a phone and the automation", (it) => {
  let bob: Page;
  let ada: Page;
  let tab: number;
  let desk: typeof Said.Type;

  /** The tab's small picture, as whoever holds `token` is given it. */
  const preview = (token: string | undefined, has?: string) =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const client = yield* HttpClient.HttpClient;
      const answered = yield* client.execute(
        HttpClientRequest.get(`${runner.url}/targets/${tab}/preview.png`).pipe(
          token === undefined ? (bare) => bare : HttpClientRequest.bearerToken(token),
          has === undefined ? (bare) => bare : HttpClientRequest.setHeader("if-none-match", has),
        ),
      );
      const picture = new Uint8Array(yield* answered.arrayBuffer);
      return { status: answered.status, tag: answered.headers["etag"], picture };
    });

  /**
   * Whether a tab that became a desktop's has the size of the window of the desktop that
   * holds it. It is a desktop's at once and of that size a moment later: until then it is
   * as wide as a phone's tab is in a window that is none, and its picture is elsewhere.
   */
  const aDesktops = (holder: Page) =>
    Effect.gen(function* () {
      const stage = yield* holder.box("[data-aperture-stage]");
      return yield* comes(
        holder,
        `!watched.mobile && watched.width === ${stage.width} && watched.height === ${stage.height}`,
      );
    });

  /** Lets go of the tab one holds, and has the other take it with a click. */
  const handOver = (from: Page, to: Page) =>
    Effect.gen(function* () {
      yield* from.evaluate("apertureSession.lease('release')");
      yield* comes(from, "s.presence.held.length === 0");
      // The picture is put in another place while its tab changes size, and a click beside
      // it is on no page: it is clicked once it is the tab's as the tab now is, which is
      // as whoever let go of it has it.
      const sized = "[watched.width, watched.height, watched.mobile].join()";
      const now = yield* snapshot(from, sized, Schema.String);
      yield* comes(to, `${sized} === ${JSON.stringify(now)}`);
      yield* pictureKeepsUp(to);
      yield* clickPicture(to, 40, 40);
      return yield* comes(
        to,
        `s.presence.held.some((h) => h.tab === ${tab} && h.holder === s.presence.you)`,
      );
    });

  it.effect("a tab's pages are a desktop's while nobody holds it from a phone", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const viewer = yield* Viewer;
      const site = yield* Echo;
      bob = yield* viewer.open(runner.page({ name: "Bob" }));
      yield* ready(bob);
      tab = yield* snapshot(bob, "s.selected", Schema.Number);
      yield* bob.evaluate(`apertureSession.go({ url: ${JSON.stringify(site.url)} })`);
      expect(yield* comes(bob, "watched.title === 'seen'", "20 seconds")).toBe(true);
      // Its click holds the tab, from a desktop.
      yield* clickPicture(bob, 40, 40);
      expect(yield* comes(bob, "s.presence.held.length === 1")).toBe(true);

      desk = yield* says(tab);
      expect(desk.agent).not.toContain("Mobile");
      expect(desk.mobile).toBe(false);
      expect(desk.touches).toBe(0);
      expect(desk.asked["sec-ch-ua-mobile"]).toBe("?0");
      expect(yield* snapshot(bob, "[s.phone, watched.mode, watched.mobile].join()")).toBe(
        "false,auto,false",
      );
    }),
  );

  it.effect("a phone that watches changes nothing", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const viewer = yield* Viewer;
      ada = yield* viewer.open(runner.page({ name: "Ada" }), {
        width: 390,
        height: 844,
        mobile: true,
      });
      yield* ready(ada, 2);
      expect(yield* snapshot(ada, "s.phone")).toBe(true);
      yield* Effect.sleep("2 seconds");
      expect(yield* snapshot(ada, "[watched.mode, watched.mobile].join()")).toBe("auto,false");
      expect((yield* says(tab)).width).toBe(desk.width);
    }),
  );

  it.effect("the tab is a phone's once the phone holds it, and the page there stays loaded", () =>
    Effect.gen(function* () {
      expect(yield* handOver(bob, ada)).toBe(true);
      // The page takes the size of the phone's window, less the workbench's bar.
      expect(yield* comes(ada, "watched.mobile && watched.width === 390")).toBe(true);
      expect(yield* snapshot(bob, "[s.phone, watched.mobile, watched.width].join()")).toBe(
        "false,true,390",
      );
      const stage = yield* ada.box("[data-aperture-stage]");
      expect(yield* snapshot(ada, "watched.height")).toBe(stage.height);
      // No bands beside the picture or above and below it, once it is drawn at its size:
      // until a picture of that size has come, the one there is has the place its own shape
      // gives it, which may be as tall as the stage and not as wide.
      yield* until(
        "the picture filling its stage",
        ada
          .box("[data-aperture-surface=video]")
          .pipe(Effect.map((box) => box.height === stage.height && box.width === stage.width)),
      );

      const now = yield* until(
        "the page being a phone's",
        says(tab).pipe(Effect.map((said) => said.width === 390 && said)),
      );
      expect(now.loaded).toBe(desk.loaded);
      expect(now.touches).toBe(5);
      expect(now.coarse).toBe(true);
    }),
  );

  it.effect("what it loads then is asked for as a phone asks, by the same browser", () =>
    Effect.gen(function* () {
      yield* ada.evaluate("apertureSession.go({ along: 'reload' })");
      const phone = yield* until(
        "the page loading again",
        says(tab).pipe(Effect.map((said) => said.loaded !== desk.loaded && said)),
      );
      expect(phone.agent).toMatch(/\(Linux; Android [^)]+\).* Mobile Safari\//u);
      expect(phone.asked["user-agent"]).toBe(phone.agent);
      expect(version(phone.agent)).toBe(version(desk.agent));
      expect(phone.asked["sec-ch-ua-mobile"]).toBe("?1");
      expect(phone.asked["sec-ch-ua-platform"]).toBe('"Android"');
      // The brands and the version are the browser's own: a phone differs in neither.
      expect(phone.asked["sec-ch-ua"]).toBe(desk.asked["sec-ch-ua"]);
      expect(phone.brands).toBe(desk.brands);
      expect(phone.versions).toBe(desk.versions);
      expect(phone.mobile).toBe(true);
      expect(phone.system).toBe("Android");
      expect(phone.forms).toBe('["Mobile"]');
      // To the page's first script as well, with this check's own DevTools session beside
      // the session's, and after one of those is gone.
      expect(phone.platform).toBe("Linux armv81");
      expect(phone.first).toBe("Linux armv81");
      expect((yield* says(tab)).platform).toBe("Linux armv81");
      expect(phone.width).toBe(390);

      // A page takes no input for a moment after it has come: it is tapped until it is.
      const touched = yield* until(
        "the page being touched",
        clickPicture(ada, 100, 100).pipe(
          Effect.andThen(Effect.sleep("700 millis")),
          Effect.andThen(says(tab)),
          Effect.map((said) => said.got.includes("click") && said.got),
        ),
        "20 seconds",
      );
      expect(touched).toContain("touchstart");
    }),
  );

  it.effect("a desktop that watches leaves it a phone's, and one that takes it does not", () =>
    Effect.gen(function* () {
      yield* Effect.sleep("1 second");
      expect(yield* snapshot(bob, "watched.mobile")).toBe(true);
      expect(yield* handOver(ada, bob)).toBe(true);
      expect(yield* aDesktops(bob)).toBe(true);
      const back = yield* until(
        "the page being a desktop's",
        says(tab).pipe(Effect.map((said) => said.touches === 0 && said)),
      );
      expect(back.agent).toBe(desk.agent);
      expect(back.platform).toBe(desk.platform);
      expect(yield* snapshot(ada, "[watched.mode, watched.mobile].join()")).toBe("auto,false");
    }),
  );

  it.effect("the automation reads the mode, and gives a tab input without changing it", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const mcp = yield* Mcp.connect(runner.url, runner.token);
      const listed = yield* mcp
        .call("tabs", {})
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Listed)));
      expect(listed).toEqual([{ tab, mode: "auto", mobile: false }]);

      // The phone holds the tab, and the automation takes it from nobody: it has no device.
      expect(yield* handOver(bob, ada)).toBe(true);
      expect(yield* comes(ada, "watched.mobile")).toBe(true);
      yield* ada.evaluate("apertureSession.lease('release')");
      yield* comes(ada, "s.presence.held.length === 0");
      yield* mcp.call("click", { tab, x: 60, y: 60 });
      expect(yield* snapshot(ada, "s.presence.members.some((m) => m.agent)")).toBe(true);
      yield* Effect.sleep("1 second");
      expect(yield* snapshot(ada, "[watched.mode, watched.mobile].join()")).toBe("auto,true");
    }),
  );

  it.effect("a mode the automation sets stays, whoever holds the tab", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const mcp = yield* Mcp.connect(runner.url, runner.token);
      const before = (yield* says(tab)).loaded;
      const set = yield* mcp
        .call("tabs", { action: "mode", tab, mode: "desktop" })
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Listed)));
      expect(set).toEqual([{ tab, mode: "desktop", mobile: false }]);
      // The page loads again, as a desktop's.
      const again = yield* until(
        "the page loading again",
        says(tab).pipe(Effect.map((said) => said.loaded !== before && said)),
      );
      expect(again.asked["sec-ch-ua-mobile"]).toBe("?0");

      // The tab is a desktop's size again, and is pressed where its picture shows it so.
      expect(yield* comes(ada, "!watched.mobile")).toBe(true);
      yield* pictureKeepsUp(ada);
      yield* clickPicture(ada, 40, 40);
      expect(
        yield* comes(ada, "s.presence.held.some((h) => h.holder === s.presence.you)", "20 seconds"),
      ).toBe(true);
      yield* Effect.sleep("1 second");
      expect(yield* snapshot(ada, "[watched.mode, watched.mobile].join()")).toBe("desktop,false");

      // The session's own route sets it as well, and tells it.
      const put = yield* runner.request("PUT", `/targets/${tab}/mode`, { mode: "mobile" });
      expect(put.status).toBe(204);
      expect(yield* comes(bob, "watched.mode === 'mobile' && watched.mobile")).toBe(true);
      const told = (yield* runner.targets).find((one) => one.tab === tab);
      expect([told?.mode, told?.mobile]).toEqual(["mobile", true]);
      expect(yield* handOver(ada, bob)).toBe(true);
      yield* Effect.sleep("1 second");
      expect(yield* snapshot(bob, "[watched.mode, watched.mobile].join()")).toBe("mobile,true");
      // A window that is no phone's leaves a phone's page the size it has.
      expect(yield* snapshot(bob, "watched.width < 500")).toBe(true);
    }),
  );

  it.effect("a member sets the mode of the tab it holds, and of no tab another holds", () =>
    Effect.gen(function* () {
      yield* ada.evaluate(
        "(window.failures = [], apertureSession.onFailure((f) => window.failures.push(f.asked)), 1)",
      );
      yield* ada.evaluate("apertureSession.setMode('desktop')");
      yield* until("the phone being refused", ada.evaluate("window.failures.includes('setMode')"));
      expect(yield* snapshot(bob, "watched.mode")).toBe("mobile");

      yield* bob.evaluate("apertureSession.setMode('auto')");
      // As on what its holder uses, which is a desktop, and of the size of its window.
      expect(yield* comes(bob, "watched.mode === 'auto'")).toBe(true);
      expect(yield* aDesktops(bob)).toBe(true);
    }),
  );

  it.effect("a tab opened from a phone's tab is a phone's from its first page", () =>
    Effect.gen(function* () {
      const site = yield* Echo;
      expect(yield* handOver(bob, ada)).toBe(true);
      expect(yield* comes(ada, "watched.mobile")).toBe(true);
      yield* ada.evaluate(
        `apertureSession.go({ url: ${JSON.stringify(`${site.url}/new`)} }, { newTab: true })`,
      );
      expect(
        yield* comes(ada, "watched.url.endsWith('/new') && watched.title === 'seen'", "20 seconds"),
      ).toBe(true);
      expect(yield* snapshot(ada, "[watched.mode, watched.mobile].join()")).toBe("auto,true");
      const opened = yield* snapshot(ada, "s.selected", Schema.Number);
      expect((yield* says(opened)).asked["sec-ch-ua-mobile"]).toBe("?1");
      // It was asked for once, as a phone's: not as a desktop's first.
      expect(site.asked().filter((path) => path === "/new")).toHaveLength(1);
    }),
  );

  it.effect("a tab has a small picture, made once in a while, for whoever is let in", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const first = yield* preview(runner.token);
      expect(first.status).toBe(200);
      expect(new TextDecoder().decode(first.picture.subarray(1, 4))).toBe("PNG");
      const width = new DataView(first.picture.buffer).getUint32(PNG_WIDTH_AT);
      expect(width).toBeLessThanOrEqual(360);
      expect(first.tag).toBeDefined();

      // Asked again at once, it is the same one, and whoever has it is told so.
      const second = yield* preview(runner.token);
      expect(second.tag).toBe(first.tag);
      const had = yield* preview(runner.token, first.tag);
      expect(had.status).toBe(304);
      expect(had.picture).toHaveLength(0);

      expect((yield* preview(undefined)).status).toBe(401);
      expect((yield* preview("not the token")).status).toBe(401);
      const none = yield* runner.request("GET", "/targets/999/preview.png");
      expect(none.status).toBe(404);
    }),
  );

  it.effect("a tab has its page's icon, which the session fetches, for whoever is let in", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const site = yield* Echo;
      const client = yield* HttpClient.HttpClient;
      const icon = (token: string | undefined, of = tab) =>
        client.execute(
          HttpClientRequest.get(`${runner.url}/targets/${of}/favicon`).pipe(
            token === undefined ? (bare) => bare : HttpClientRequest.bearerToken(token),
          ),
        );
      const before = site.asked().filter((path) => path === "/icon.png").length;
      const first = yield* icon(runner.token);
      expect(first.status).toBe(200);
      expect(first.headers["content-type"]).toBe("image/png");
      expect(new Uint8Array(yield* first.arrayBuffer)).toEqual(ICON);
      // Asked again, it is the one the session has: the site is not asked each time.
      const asked = site.asked().filter((path) => path === "/icon.png").length;
      expect((yield* icon(runner.token)).status).toBe(200);
      expect(site.asked().filter((path) => path === "/icon.png")).toHaveLength(asked);
      expect(asked - before).toBeLessThanOrEqual(1);

      expect((yield* icon(undefined)).status).toBe(401);
      expect((yield* icon("not the token")).status).toBe(401);
      expect((yield* icon(runner.token, 999)).status).toBe(404);
    }),
  );

  it.effect(
    "a phone held on its side has a rail beside the picture, and sheets from that side",
    () =>
      Effect.gen(function* () {
        const runner = yield* Runner.Runner;
        const viewer = yield* Viewer;
        const eve = yield* viewer.open(runner.page({ name: "Eve" }), {
          width: 844,
          height: 390,
          mobile: true,
        });
        const phone = `document.querySelector("[data-workbench-phone]")`;
        const menu = `document.querySelector("[data-menu-sheet]")`;
        /** A sheet that has come in: it does a moment after what it shows is there. */
        const landed = (sheet: string) =>
          eve.until(
            `${sheet} !== null && ${sheet}.hasAttribute("data-open") && !${sheet}.hasAttribute("data-starting-style") && ${sheet}.getAnimations().every((one) => one.playState === "finished")`,
          );
        /** The menu, by its button once the rail the button is in has come to rest. */
        const opened = Effect.gen(function* () {
          yield* eve.click("[data-workbench-menu]");
          yield* eve.until(`${menu} !== null`);
        }).pipe(Effect.andThen(landed(menu)));
        const turn = (width: number, height: number) =>
          eve.cdp.call("Emulation.setDeviceMetricsOverride", {
            width,
            height,
            deviceScaleFactor: 1,
            mobile: true,
            screenOrientation: ViewerLive.held(width, height),
          });
        yield* eve.until(`${phone}?.dataset.lay === "right"`, "30 seconds");
        // The rail is as long as what it holds, and has who else is here once they are told:
        // what is pressed in it is where it is to be by then.
        yield* eve.until(
          `!!document.querySelector("[data-workbench-phone-bar] [data-session-presence]")`,
          "30 seconds",
        );
        // The rail is over the picture, which has the whole of the window, and all that
        // is pressed in it is as large as a finger needs.
        const laid = `(() => {
        const box = (selector) => document.querySelector(selector).getBoundingClientRect();
        const pill = box("[data-workbench-phone-pill]");
        const stage = box("[data-aperture-stage]");
        const pressed = [...document.querySelectorAll("[data-workbench-phone-bar] button")];
        return {
          rows: document.querySelectorAll("[data-workbench-titlebar], [data-workbench-toolbar]").length,
          fills: stage.width === innerWidth && stage.height === innerHeight,
          upright: pill.height > pill.width,
          wide: pill.width > innerWidth * 0.9,
          within: pill.left >= 0 && pill.right <= innerWidth && pill.top >= 0 && pill.bottom <= innerHeight,
          large: pressed.length >= 3 && pressed.every((one) => {
            const size = one.getBoundingClientRect();
            return size.width >= 40 && size.height >= 40;
          }),
        };
      })()`;
        expect(yield* eve.evaluate(laid)).toEqual({
          rows: 0,
          fills: true,
          upright: true,
          wide: false,
          within: true,
          large: true,
        });

        // The menu comes in from the rail's side, as tall as the window, and stays the
        // one menu as the phone is turned: a sheet at the foot upright, half of the way up.
        yield* opened;
        const side = `(() => {
        const sheet = ${menu}.getBoundingClientRect();
        return [${menu}.dataset.side, sheet.top === 0, sheet.height === innerHeight, Math.round(sheet.right) === innerWidth, sheet.width < innerWidth * 0.6].join();
      })()`;
        expect(yield* eve.evaluate(side)).toBe("right,true,true,true,true");
        yield* turn(390, 844);
        yield* eve.until(`${phone}.dataset.lay === "foot" && ${menu}?.dataset.side === "bottom"`);
        yield* landed(menu);
        expect(
          yield* eve.evaluate(
            `(() => {
            const sheet = ${menu}.getBoundingClientRect();
            return [document.querySelectorAll("[data-menu-sheet]").length, ${menu}.dataset.height, sheet.width === innerWidth, sheet.top > innerHeight * 0.45 && sheet.top < innerHeight * 0.55].join();
          })()`,
          ),
        ).toBe("1,part,true,true");
        // It follows a finger: up to be whole, and down from there to be gone.
        const drawn = (x: number, from: number, to: number) =>
          eve.finger(ViewerLive.along({ x, y: from }, { x, y: to }), "150 millis");
        const top = `${menu}.getBoundingClientRect().top`;
        yield* drawn(195, (yield* eve.evaluate(top, Schema.Number)) + 10, 150);
        yield* eve.until(`${menu}.dataset.height === "full"`);
        yield* landed(menu);
        yield* drawn(195, (yield* eve.evaluate(top, Schema.Number)) + 10, 830);
        yield* eve.until(`${menu} === null`);
        expect(yield* eve.evaluate(laid)).toMatchObject({
          upright: false,
          wide: true,
          within: true,
        });

        // On its side again, the menu is dragged to its side to be rid of it, and nothing
        // of it is left over the picture.
        yield* turn(844, 390);
        yield* eve.until(`${phone}.dataset.lay === "right"`);
        yield* opened;
        const left = yield* eve.evaluate(`${menu}.getBoundingClientRect().left`, Schema.Number);
        yield* eve.finger(
          ViewerLive.along({ x: left + 40, y: 12 }, { x: left + 330, y: 12 }),
          "150 millis",
        );
        yield* eve.until(
          `${menu} === null && document.querySelectorAll("[data-slot=drawer-overlay]").length === 0`,
        );
        expect(eve.errors()).toEqual([]);
        yield* eve.close;
      }),
  );

  it.effect("a tab's icon is the one its page names, though asked for before the page has", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const site = yield* Echo;
      const client = yield* HttpClient.HttpClient;
      yield* bob.evaluate(
        `apertureSession.go({ url: ${JSON.stringify(`${site.url}/late`)} }, { newTab: true })`,
      );
      // The tab is there once its page has come, which is before the page has said all
      // of its head: whoever lists the tabs asks for its icon then.
      const late = yield* until(
        "the tab of the page that is slow to say its head",
        runner.targets.pipe(Effect.map((all) => all.find((one) => one.url.endsWith("/late"))?.tab)),
      );
      const icon = yield* client.execute(
        HttpClientRequest.get(`${runner.url}/targets/${late}/favicon`).pipe(
          HttpClientRequest.bearerToken(runner.token),
        ),
      );
      expect(icon.status).toBe(200);
      expect(new Uint8Array(yield* icon.arrayBuffer)).toEqual(ICON);
      // The site's own, which a page that names none has, was not asked for in its place.
      expect(site.asked()).not.toContain("/favicon.ico");
      yield* bob.evaluate(`apertureSession.closeTab(${late})`);
      expect(yield* comes(bob, `!s.targets.some((target) => target.tab === ${late})`)).toBe(true);
    }),
  );

  it.effect("the pages threw nothing", () =>
    Effect.sync(() => {
      expect(bob.errors()).toEqual([]);
      expect(ada.errors()).toEqual([]);
    }),
  );
});
