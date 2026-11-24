import { suite } from "@aperture-browser/e2e/src/suite.ts";
import * as Viewer from "@aperture-browser/e2e/src/viewer.ts";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Control from "./src/control.ts";
import * as Proxy from "./src/proxy.ts";
import { LONG, needs, shot, signInWithToken, withSession } from "./src/console.ts";

/** How long a page is watched for what it asks while nothing answers it. */
const WATCHED_FOR = "10 seconds";
/**
 * How often one thing may be asked in that time: when the page comes, and after pauses of
 * one, two and four seconds, with one more for a clock that is not the page's own.
 */
const ASKED_MOST = 5;
/** A page is itself again by the next time it asks, which is half a minute away at most. */
const BACK_WITHIN = "60 seconds";

const NOT_ANSWERING = `main[data-console-not-answering]`;
const NOTICE = `[...document.querySelectorAll("[data-sonner-toast]")].some((one) => one.textContent.includes("Aperture is not answering"))`;

const Asked = Schema.Record(Schema.String, Schema.Number);

/** Has a page count what it asks of the control plane from now on. */
const counts = (page: Viewer.Page) =>
  page.evaluate(
    `void (performance.setResourceTimingBufferSize(100000), window.countedFrom = performance.now())`,
  );

/** How often a page asked each thing of the control plane since it was told to count; since it came, without. */
const asked = (page: Viewer.Page) =>
  page.evaluate(
    `(() => {
      const by = {};
      for (const one of performance.getEntriesByType("resource")) {
        const path = new URL(one.name).pathname;
        if (path.startsWith("/api/") && one.startTime >= (window.countedFrom ?? 0)) {
          by[path] = (by[path] ?? 0) + 1;
        }
      }
      return by;
    })()`,
    Asked,
  );

/** Holds each page to asking nothing more often than it may, and tells how often it did. */
const fewOf = (pages: Readonly<Record<string, Viewer.Page>>) =>
  Effect.gen(function* () {
    for (const [name, page] of Object.entries(pages)) {
      const by = yield* asked(page);
      console.log(`asked in ${WATCHED_FOR} with no database, ${name}: ${JSON.stringify(by)}`);
      expect(
        Math.max(0, ...Object.values(by)),
        `${name}: ${JSON.stringify(by)}`,
      ).toBeLessThanOrEqual(ASKED_MOST);
    }
  });

const PHONE = { width: 390, height: 844, mobile: true } as const;

suite(needs)("the console while the control plane has no database", (it) => {
  it.effect(
    "whoever is signed in is told that Aperture is not answering, and has the page back when it does",
    () =>
      Effect.gen(function* () {
        const control = yield* Control.Control;
        const proxy = yield* Proxy.Proxy;
        const viewer = yield* Viewer.Viewer;
        const fs = yield* FileSystem.FileSystem;
        const { account, path } = yield* withSession("Dana");
        const id = path.split("/").at(-1) ?? "";
        const card = `[data-console-session="${id}"]`;

        // Two pages that show what they were answered: the sessions, and one of them.
        const list = yield* viewer.open(`${proxy.url}/-/sessions`);
        yield* signInWithToken(list, account.token);
        yield* list.until(`!!document.querySelector('${card}')`, "30 seconds");
        const open = yield* viewer.open(`${proxy.url}/-/sessions/${id}`, { scheme: "dark" });
        yield* open.until(`!!document.querySelector("[data-aperture-drawn]")`, "60 seconds");

        yield* control.database.stops;
        yield* counts(list);
        yield* counts(open);
        // And three that come while nothing is answered, and have nothing to show.
        const session = yield* viewer.open(`${proxy.url}/-/sessions/${id}`);
        const sessions = yield* viewer.open(`${proxy.url}/-/sessions`, { scheme: "dark" });
        const phone = yield* viewer.open(`${proxy.url}/-/sessions/${id}`, PHONE);
        yield* Effect.sleep(WATCHED_FOR);
        yield* fewOf({
          "the sessions, shown before": list,
          "a session, shown before": open,
          "a session": session,
          "the sessions": sessions,
          "a session on a phone": phone,
        });

        // What was shown stays, under word of it; what was not is word of it alone.
        yield* list.until(NOTICE);
        expect(yield* list.evaluate(`!!document.querySelector('${card}')`, Schema.Boolean)).toBe(
          true,
        );
        yield* open.until(NOTICE);
        expect(
          yield* open.evaluate(`!!document.querySelector("[data-aperture-drawn]")`, Schema.Boolean),
        ).toBe(true);
        for (const page of [session, sessions, phone]) {
          yield* page.until(`!!document.querySelector('${NOT_ANSWERING} [data-console-try-now]')`);
          expect(yield* page.evaluate(NOTICE, Schema.Boolean)).toBe(false);
        }
        yield* shot(list, fs, "console-down-notice-light");
        yield* shot(open, fs, "console-down-notice-dark");
        yield* shot(session, fs, "console-down-light");
        yield* shot(sessions, fs, "console-down-dark");
        yield* shot(phone, fs, "console-down-phone");

        // A session that is opened from the ones shown says so in the workbench's place.
        yield* list.click(`${card} [data-console-session-open]`);
        yield* list.until(
          `!!document.querySelector('[data-console-session-note="unanswered"] [data-console-not-answering]')`,
        );
        yield* list.until(`!(${NOTICE})`);
        yield* shot(list, fs, "console-down-session-light");

        yield* control.database.starts;
        // Asked now, by whoever does not wait.
        yield* list.click("[data-console-try-now]");
        yield* list.until(`!!document.querySelector("[data-aperture-drawn]")`, BACK_WITHIN);
        // And by themselves.
        yield* session.until(`!!document.querySelector("[data-aperture-drawn]")`, BACK_WITHIN);
        yield* phone.until(`!!document.querySelector("[data-aperture-drawn]")`, BACK_WITHIN);
        yield* sessions.until(`!!document.querySelector('${card}')`, BACK_WITHIN);
        yield* open.until(`!(${NOTICE})`, BACK_WITHIN);
        for (const page of [list, open, session, sessions, phone]) {
          expect(
            yield* page.evaluate(
              `!!document.querySelector("[data-console-not-answering]")`,
              Schema.Boolean,
            ),
          ).toBe(false);
          yield* page.close;
        }
      }),
    LONG,
  );

  it.effect(
    "whoever is not signed in is told the same where they would sign in, set Aperture up or join",
    () =>
      Effect.gen(function* () {
        const control = yield* Control.Control;
        const proxy = yield* Proxy.Proxy;
        const viewer = yield* Viewer.Viewer;
        const fs = yield* FileSystem.FileSystem;
        // The browser is the one the check before signed in with: nothing of that is left.
        const first = yield* viewer.open(`${proxy.url}/`);
        yield* first.evaluate(`void localStorage.clear()`);
        yield* first.close;

        yield* control.database.stops;
        const signIn = yield* viewer.open(`${proxy.url}/`);
        const session = yield* viewer.open(`${proxy.url}/-/sessions/none`, { scheme: "dark" });
        const setup = yield* viewer.open(`${proxy.url}/setup#token=none`);
        const share = yield* viewer.open(`${proxy.url}/share/none#none`);
        const phone = yield* viewer.open(`${proxy.url}/`, { ...PHONE, scheme: "dark" });
        const pages = {
          "signing in": signIn,
          "a session": session,
          "setting up": setup,
          "a share link": share,
          "signing in on a phone": phone,
        };
        yield* Effect.sleep(WATCHED_FOR);
        yield* fewOf(pages);
        for (const page of Object.values(pages)) {
          yield* page.until(`!!document.querySelector('${NOT_ANSWERING} [data-console-try-now]')`);
        }
        yield* shot(signIn, fs, "console-down-signed-out-light");
        yield* shot(session, fs, "console-down-signed-out-dark");
        yield* shot(phone, fs, "console-down-signed-out-phone-dark");

        yield* control.database.starts;
        yield* share.click("[data-console-try-now]");
        // A link that is none lets nobody in, which is said once Aperture answers so.
        yield* share.until(
          `!!document.querySelector('[data-console-guest="refused"]')`,
          BACK_WITHIN,
        );
        const form = `!!document.querySelector('[data-console-sign-in="password"]')`;
        yield* signIn.until(form, BACK_WITHIN);
        yield* session.until(form, BACK_WITHIN);
        yield* phone.until(form, BACK_WITHIN);
        yield* setup.until(`!!document.querySelector("[data-console-first-admin]")`, BACK_WITHIN);
        for (const page of Object.values(pages)) {
          yield* page.close;
        }
      }),
    LONG,
  );
});
