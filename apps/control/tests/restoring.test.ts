import * as Executor from "@aperture-browser/e2e/src/executor.ts";
import * as Site from "@aperture-browser/e2e/src/site.ts";
import { suite } from "@aperture-browser/e2e/src/suite.ts";
import * as Viewer from "@aperture-browser/e2e/src/viewer.ts";
import { until } from "@aperture-browser/e2e/src/wait.ts";
import { expect } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { shot } from "./src/console.ts";
import * as Control from "./src/control.ts";
import { registeredWith } from "./src/node.ts";

// A session that is created with a storage state is answered for once its browser runs,
// and is given the state after: it says that it is being restored until all of it is in.

const NO_ICON = '<link rel="icon" href="data:,">';

/** A page that notes what its own script found of the state as it started. */
const PAGE = `${NO_ICON}<title>restored</title>
<script>window.early = { cookie: document.cookie, kept: localStorage.getItem("kept") };</script>`;

const Early = Schema.Struct({ cookie: Schema.String, kept: Schema.NullOr(Schema.String) });

const SessionTargets = Schema.Array(Schema.Struct({ id: Schema.String, url: Schema.String }));

interface StageService {
  readonly site: Site.Site;
  /** Lets the site answer for its page, which it holds back until then. */
  readonly answer: Effect.Effect<void>;
  /** The cookies each request for the page came with. */
  readonly cookies: () => readonly string[];
}

class Stage extends Context.Service<Stage, StageService>()(
  "@aperture-browser/control/tests/RestoringStage",
) {}

const stage = Layer.effect(
  Stage,
  Effect.gen(function* () {
    const held = yield* Deferred.make<void>();
    const cookies: string[] = [];
    const site = yield* Site.serve(
      Site.by((request) => {
        cookies.push(request.headers["cookie"] ?? "");
        return Effect.andThen(Deferred.await(held), Site.html(PAGE));
      }),
    );
    return {
      site,
      answer: Effect.asVoid(Deferred.succeed(held, undefined)),
      cookies: () => cookies,
    } satisfies StageService;
  }),
);

const needs = Layer.mergeAll(stage, Viewer.layer).pipe(
  Layer.provideMerge(registeredWith({ APERTURE_EGRESS_ALLOW: "127.0.0.1" })),
  Layer.provideMerge(Control.layer()),
);

const OVER = "[data-session-restoring]";

suite(needs)("a session created with a storage state", (it) => {
  let ada: Effect.Success<ReturnType<typeof Control.account>>;
  let session = "";
  let light: Viewer.Page;
  let dark: Viewer.Page;

  const observed = Effect.suspend(() => ada.api.sessions.get({ params: { id: session } }));

  it.effect("is answered for before the state is in, and says it is being restored", () =>
    Effect.gen(function* () {
      const { site } = yield* Stage;
      ada = yield* Control.account("Ada");
      const created = yield* ada.api.sessions.create({
        payload: {
          storageState: {
            cookies: [
              { name: "sid", value: "abc", domain: "127.0.0.1", hostOnly: true, path: "/" },
            ],
            origins: [{ origin: site.url, localStorage: [{ name: "kept", value: "v" }] }],
            tabs: [{ url: `${site.url}/page`, active: true }],
          },
        },
      });
      session = created.id;
      // The site has not answered for the tab's page, so the state is not all in.
      expect(created).toMatchObject({ observedState: "restoring", failure: null });
      expect((yield* observed).observedState).toBe("restoring");
    }),
  );

  it.effect("its workbench shows the picture with what is being put in over it", () =>
    Effect.gen(function* () {
      const viewer = yield* Viewer.Viewer;
      const fs = yield* FileSystem.FileSystem;
      const watching = yield* ada.api.sessions.createTicket({
        params: { id: session },
        payload: { access: { input: "rw", tabs: "rw" } },
      });
      light = yield* viewer.open(watching.url, { scheme: "light" });
      dark = yield* viewer.open(watching.url, { scheme: "dark" });
      for (const page of [light, dark]) {
        yield* page.until(`!!document.querySelector('${OVER}[data-session-restoring="underway"]')`);
        yield* page.until(`document.querySelector('${OVER}').textContent.includes("1 tab")`);
        expect(yield* page.text(OVER)).toContain(
          "Putting in 1 tab, 1 cookie, the storage of 1 site.",
        );
      }
      yield* shot(light, fs, "workbench-restoring-light");
      yield* shot(dark, fs, "workbench-restoring-dark");
    }),
  );

  it.effect("it takes no input, and offers neither its automation nor DevTools meanwhile", () =>
    Effect.gen(function* () {
      const executor = yield* Executor.Executor;
      // A press on the picture lands on what is over it.
      const middle = yield* light.box(OVER);
      expect(
        yield* light.evaluate(
          `document.elementFromPoint(${middle.x}, ${middle.y}).closest('${OVER}') !== null`,
        ),
      ).toBe(true);
      const tools = yield* executor.session(session, "POST", "/mcp", {});
      expect(tools.status).toBe(409);
      expect(JSON.stringify(tools.body)).toContain("being restored");
      expect((yield* executor.session(session, "GET", "/cdp/json/version")).status).toBe(409);
      // It is watched all the same.
      expect((yield* executor.session(session, "GET", "/targets")).status).toBe(200);
      expect((yield* observed).observedState).toBe("restoring");
    }),
  );

  it.effect("it runs once all of the state is in, which no page of it loaded before", () =>
    Effect.gen(function* () {
      const executor = yield* Executor.Executor;
      const { site, answer, cookies } = yield* Stage;
      yield* answer;
      yield* until(
        "the session running",
        observed.pipe(Effect.map((seen) => seen.observedState === "running")),
        "60 seconds",
      );
      for (const page of [light, dark]) {
        yield* page.until(`!document.querySelector('${OVER}')`);
      }
      // The one request for the page came with the cookie, and its script found the storage.
      expect(cookies()).toEqual(["sid=abc"]);
      const listed = yield* until(
        "the session telling of the page's tab alone",
        executor.session(session, "GET", "/targets").pipe(
          Effect.flatMap((answered) => Schema.decodeUnknownEffect(SessionTargets)(answered.body)),
          Effect.map((all) =>
            all.length === 1 && all[0]?.url === `${site.url}/page` ? all : undefined,
          ),
        ),
      );
      const cdp = yield* executor.cdp(session);
      const page = yield* cdp.attach(listed[0]!.id);
      expect(yield* page.evaluate("window.early", Early)).toEqual({ cookie: "sid=abc", kept: "v" });
      expect((yield* executor.session(session, "POST", "/mcp", {})).status).not.toBe(409);
    }),
  );

  it.effect("one whose browser does not take the state fails, and says why", () =>
    Effect.gen(function* () {
      const executor = yield* Executor.Executor;
      const refused = yield* ada.api.sessions.create({
        payload: { storageState: { tabs: [{ url: "about:blank" }] } },
      });
      // It is made all the same, and its node may be stopping its browser already.
      const failed = yield* until(
        "the session being told as failed",
        ada.api.sessions
          .get({ params: { id: refused.id } })
          .pipe(Effect.map((seen) => (seen.observedState === "failed" ? seen : undefined))),
        "60 seconds",
      );
      expect(failed.failure).toMatch(/the storage state was not taken: .*no page on the web/u);
      // Its browser is stopped: nothing of it is reached, and nothing looks healthy.
      expect((yield* executor.session(refused.id, "GET", "/targets")).status).not.toBe(200);
      yield* ada.api.sessions.delete({ params: { id: refused.id } });

      // A state has no browser to go to in a session that is created at rest.
      const atRest = yield* Effect.flip(
        ada.api.sessions.create({ payload: { suspended: true, storageState: {} } }),
      );
      expect(atRest).toMatchObject({ _tag: "NodeRefused", code: "invalid_argument" });
    }),
  );
});
