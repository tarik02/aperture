import { suite } from "@aperture-browser/e2e/src/suite.ts";
import * as Viewer from "@aperture-browser/e2e/src/viewer.ts";
import { until } from "@aperture-browser/e2e/src/wait.ts";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Control from "./src/control.ts";
import * as Proxy from "./src/proxy.ts";
import { totp } from "./src/totp.ts";
import {
  BUTTONS,
  DIALOG,
  ENTER,
  ESCAPE,
  alike,
  choose,
  needs,
  noteStarting,
  pick,
  placed,
  pressUntil,
  rested,
  shot,
  stands,
  started,
  toAccount,
} from "./src/console.ts";

suite(needs)("what a person signs in to the console with, behind the proxy", (it) => {
  it.effect("a person follows a setup link, signs in, and opens a session with cookies alone", () =>
    Effect.gen(function* () {
      const proxy = yield* Proxy.Proxy;
      const control = yield* Control.Control;
      const viewer = yield* Viewer.Viewer;
      const fs = yield* FileSystem.FileSystem;
      const bootstrap = yield* control.as(control.bootstrapToken);
      const email = "mira@example.test";
      const password = "a password of Mira's own";
      const mira = yield* bootstrap.accounts.create({ payload: { name: "Mira", email } });
      const { token } = yield* bootstrap.accounts.createSetupToken({ params: { id: mira.id } });

      const page = yield* viewer.open(`${proxy.url}/invite#token=${encodeURIComponent(token)}`);
      yield* page.until(`!!document.querySelector("[data-console-invite] input")`);
      // The browser is the one the check before signed in with: nothing of that is left.
      yield* page.evaluate(
        `(localStorage.clear(), fetch("/api/control/route/cookie", { method: "DELETE" }).then((answer) => answer.status))`,
      );
      // The page before the reload has the field as well: the one after is waited for.
      yield* page.evaluate("void (window.beforeReload = true, location.reload())");
      yield* page.until(
        `!window.beforeReload && localStorage.length === 0 && !!document.querySelector("[data-console-invite] input")`,
      );
      yield* page.click("[data-console-invite] input");
      yield* page.type(password);
      yield* page.key("Enter", "Enter", ENTER);

      // The way in, since setting a password signs nobody in.
      yield* page.until(`!!document.querySelector('[data-console-sign-in="password"]')`);
      yield* page.click(`[data-console-sign-in] input[name="email"]`);
      yield* page.type(email);
      yield* page.click(`[data-console-sign-in] input[name="password"]`);
      yield* page.type(password);
      yield* shot(page, fs, "console-sign-in");
      yield* page.key("Enter", "Enter", ENTER);

      yield* page.until(`!!document.querySelector("[data-console-create]")`);
      yield* noteStarting(page);
      yield* page.click("[data-console-create]");
      yield* started(page);
      // The session's socket went through the proxy with the cookies of whoever signed in.
      yield* page.until(
        `[...document.querySelectorAll("[data-aperture-surface]")].some((surface) => surface.getBoundingClientRect().width > 0)`,
        "60 seconds",
      );
      // Who is there is told a moment after the picture is.
      yield* Viewer.ready(page);
      const me = yield* page.evaluate(
        `(() => {
          const { presence } = apertureSession.getSnapshot();
          return presence.members.find((member) => member.id === presence.you)?.name ?? "";
        })()`,
        Schema.String,
      );
      expect(me).toBe("Mira");
      expect(page.errors()).toEqual([]);
    }),
  );

  it.effect("a person turns a second factor on in the console, and signs in with a code", () =>
    Effect.gen(function* () {
      const proxy = yield* Proxy.Proxy;
      const control = yield* Control.Control;
      const viewer = yield* Viewer.Viewer;
      const fs = yield* FileSystem.FileSystem;
      const bootstrap = yield* control.as(control.bootstrapToken);
      const email = "noor@example.test";
      const password = "a password of Noor's own";
      const noor = yield* bootstrap.accounts.create({ payload: { name: "Noor", email } });
      const { token } = yield* bootstrap.accounts.createSetupToken({ params: { id: noor.id } });

      const page = yield* viewer.open(`${proxy.url}/api/control/openapi.json`);
      const asked = (path: string, body: object) =>
        page.evaluate(
          `fetch(${JSON.stringify(`/api/auth${path}`)}, { method: "POST", headers: { "Content-Type": "application/json" }, body: ${JSON.stringify(JSON.stringify(body))} }).then((answer) => answer.status)`,
          Schema.Number,
        );
      const signIn = Effect.gen(function* () {
        yield* page.evaluate(`void (location.href = "/")`);
        yield* page.until(`!!document.querySelector('[data-console-sign-in="password"]')`);
        yield* page.click(`[data-console-sign-in] input[name="email"]`);
        yield* page.type(email);
        yield* page.click(`[data-console-sign-in] input[name="password"]`);
        yield* page.type(password);
        yield* page.key("Enter", "Enter", ENTER);
      });
      // The browser is the one the check before signed in with: its person is signed out first.
      expect(yield* until("the page being there to sign out from", asked("/sign-out", {}))).toBe(
        200,
      );
      expect(yield* asked("/reset-password", { token, newPassword: password })).toBe(200);
      yield* signIn;

      // How one signs in is a tab of the account's page: the second factor is told there to
      // be off, and is turned on in a dialog that asks the password first.
      yield* page.until(`!!document.querySelector("[data-console-security]")`);
      const dialog = (step: string) => `[data-console-security-dialog="${step}"]`;
      yield* toAccount(page, "security");
      yield* page.until(`!!document.querySelector('[data-console-second-factor="off"]')`);
      yield* shot(page, fs, "console-account-security");
      yield* pressUntil(
        page,
        "[data-console-second-factor-change]",
        `document.querySelector('${dialog("none")} input')`,
      );
      // Nothing within a step moves its buttons; the dialog goes from one step to the
      // next, and is measured once it is there.
      const still = page.until(
        `document.querySelector('[data-slot="dialog-content"]').getAnimations().length === 0`,
      );
      const first = [yield* placed(page)];
      yield* page.click(`${dialog("none")} input`);
      yield* page.key("Enter", "Enter", ENTER);
      yield* page.until(`!!document.querySelector('${dialog("none")} [data-slot="field-error"]')`);
      first.push(yield* placed(page));
      alike(first);
      yield* page.type(password);
      yield* page.key("Enter", "Enter", ENTER);
      yield* page.until(`!!document.querySelector('${dialog("confirm")} input')`);
      // The address as a picture, for an authenticator's camera.
      yield* page.until(
        `(document.querySelector("[data-console-totp-qr] path")?.getAttribute("d")?.length ?? 0) > 100`,
      );
      yield* still;
      yield* shot(page, fs, "console-totp");
      const second = [yield* placed(page)];
      // And as text in the picture's place, for whoever cannot scan it.
      yield* page.click("[data-console-totp-manual]");
      yield* page.until(`!!document.querySelector("[data-console-totp-uri] code")`);
      const uri = (yield* page.text("[data-console-totp-uri] code")) ?? "";
      yield* shot(page, fs, "console-totp-manual");
      second.push(yield* placed(page));
      alike(second);
      expect(uri).toMatch(/^otpauth:\/\/totp\/Aperture:/u);
      yield* page.click(`${dialog("confirm")} input`);
      // The whole code gives itself: nothing is left to press.
      yield* page.type(yield* totp(uri));
      yield* page.until(`!!document.querySelector('${dialog("backup-codes")}')`);
      expect(yield* page.text("[data-console-backup-codes] code")).toMatch(/\w{5}-\w{5}/u);
      yield* still;
      yield* shot(page, fs, "console-backup-codes");
      // The codes are shown once, and closed by their own button: the page says it is on.
      yield* page.key("Escape", "Escape", ESCAPE);
      expect(yield* page.evaluate(`!!document.querySelector('${dialog("backup-codes")}')`)).toBe(
        true,
      );
      yield* choose(page, `${DIALOG} button`, "Done");
      yield* page.until(
        `!document.querySelector('${DIALOG}') && !!document.querySelector('[data-console-second-factor="on"]')`,
      );
      expect(
        yield* page.evaluate(`!!document.querySelector("[data-console-renew-backup-codes]")`),
      ).toBe(true);

      // The password alone leads to the code, and nowhere further.
      expect(yield* asked("/sign-out", {})).toBe(200);
      yield* signIn;
      yield* page.until(`!!document.querySelector('[data-console-sign-in="code"] input')`);
      yield* shot(page, fs, "console-sign-in-code");
      yield* page.click("[data-console-sign-in] input");
      // The whole code gives itself: nothing is left to press.
      yield* page.type(yield* totp(uri));
      yield* page.until(`!!document.querySelector("[data-console-security]")`);
      expect(page.errors()).toEqual([]);
    }),
  );

  it.effect(
    "a list keeps what it is narrowed by in its address, and a tab that signs out or in takes the others along",
    () =>
      Effect.gen(function* () {
        const proxy = yield* Proxy.Proxy;
        const control = yield* Control.Control;
        const viewer = yield* Viewer.Viewer;
        const bootstrap = yield* control.as(control.bootstrapToken);
        const email = "odo@example.test";
        const password = "a password of Odo's own";
        const odo = yield* bootstrap.accounts.create({ payload: { name: "Odo", email } });
        const { token } = yield* bootstrap.accounts.createSetupToken({ params: { id: odo.id } });

        const page = yield* viewer.open(`${proxy.url}/api/control/openapi.json`);
        const asked = (path: string, body: object) =>
          page.evaluate(
            `fetch(${JSON.stringify(`/api/auth${path}`)}, { method: "POST", headers: { "Content-Type": "application/json" }, body: ${JSON.stringify(JSON.stringify(body))} }).then((answer) => answer.status)`,
            Schema.Number,
          );
        const signIn = (tab: Viewer.Page) =>
          Effect.gen(function* () {
            yield* tab.until(`!!document.querySelector('[data-console-sign-in="password"]')`);
            yield* rested(tab);
            yield* tab.click(`[data-console-sign-in] input[name="email"]`);
            yield* tab.type(email);
            yield* tab.click(`[data-console-sign-in] input[name="password"]`);
            yield* tab.type(password);
            yield* tab.key("Enter", "Enter", ENTER);
          });
        // The browser is the one the checks before signed in with: nothing of that is left.
        expect(yield* until("the page being there to sign out from", asked("/sign-out", {}))).toBe(
          200,
        );
        yield* page.evaluate(
          `(localStorage.clear(), fetch("/api/control/route/cookie", { method: "DELETE" }).then((answer) => answer.status))`,
        );
        expect(yield* asked("/reset-password", { token, newPassword: password })).toBe(200);
        yield* page.evaluate(`void (location.href = "/-/sessions")`);
        yield* signIn(page);
        yield* page.until(`!!document.querySelector("[data-console-create]")`);

        // What the list is narrowed by is in the address, and is there again after a reload.
        const sought = "nothing is called this";
        const search = `document.querySelector('input[type="search"]')`;
        const narrowed = `new URLSearchParams(location.search).get("q") === ${JSON.stringify(sought)} && new URLSearchParams(location.search).get("status") === "suspended"`;
        yield* rested(page);
        yield* page.click(`input[type="search"]`);
        yield* page.type(sought);
        yield* pick(page, `[data-slot="select-trigger"][aria-label="Status"]`, "Suspended");
        yield* page.until(narrowed);
        yield* page.evaluate("void location.reload()");
        yield* page.until(
          `${narrowed} && ${search}?.value === ${JSON.stringify(sought)} && document.querySelector('[data-slot="select-trigger"][aria-label="Status"]')?.textContent.includes("Suspended") && !!document.querySelector("[data-console-empty]")`,
        );

        // Another tab of the same browser is signed out with this one, where it was, and
        // has nothing of whoever was signed in left on it.
        const other = yield* viewer.open(`${proxy.url}/-/workspaces`);
        yield* other.until(`!!document.querySelector("[data-console-sign-out]")`);
        yield* rested(page);
        yield* page.click("[data-console-sign-out]");
        yield* page.until(`!!document.querySelector('${BUTTONS} button:last-child')`);
        yield* placed(page);
        yield* page.click(`${BUTTONS} button:last-child`);
        yield* other.until(
          `!!document.querySelector('[data-console-sign-in="password"]') && !document.querySelector("[data-console-sign-out]") && location.pathname === "/-/workspaces"`,
        );
        // And signed in with the other, without being asked anything itself.
        yield* page.until(`!!document.querySelector('[data-console-sign-in="password"]')`);
        yield* signIn(other);
        yield* other.until(`!!document.querySelector("[data-console-sign-out]")`);
        yield* page.until(`!!document.querySelector("[data-console-sign-out]")`);
        expect(page.errors()).toEqual([]);
        expect(other.errors()).toEqual([]);
        yield* other.close;
      }),
  );

  it.effect("a person adds a passkey in the console, and signs in with it and nothing else", () =>
    Effect.gen(function* () {
      const proxy = yield* Proxy.Proxy;
      const control = yield* Control.Control;
      const viewer = yield* Viewer.Viewer;
      const fs = yield* FileSystem.FileSystem;
      const bootstrap = yield* control.as(control.bootstrapToken);
      const email = "pia@example.test";
      const password = "a password of Pia's own";
      const pia = yield* bootstrap.accounts.create({ payload: { name: "Pia", email } });
      const { token } = yield* bootstrap.accounts.createSetupToken({ params: { id: pia.id } });

      // A passkey is of a name and never of an address in numbers: the proxy by its name,
      // where the browser has nothing of the checks before.
      const base = proxy.url.replace("127.0.0.1", "localhost");
      const page = yield* viewer.open(`${base}/api/control/openapi.json`);
      // An authenticator of the browser's own, which makes and shows passkeys once it is
      // told that someone is there. It is told for what the person does themselves, and
      // not before: the page that signs in asks for a passkey where the address is typed
      // as soon as it is there, and an authenticator that answers that by itself signs
      // the person in again before they are seen to be out.
      yield* page.cdp.call("WebAuthn.enable", {});
      const { authenticatorId } = yield* page.cdp.call(
        "WebAuthn.addVirtualAuthenticator",
        {
          options: {
            protocol: "ctap2",
            transport: "internal",
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: false,
          },
        },
        Schema.Struct({ authenticatorId: Schema.String }),
      );
      const present = (enabled: boolean) =>
        page.cdp.call("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId, enabled });
      const asked = <A>(path: string, body: object, answer: Schema.Codec<A>) =>
        page.evaluate(
          `fetch(${JSON.stringify(`/api/auth${path}`)}, { method: "POST", headers: { "Content-Type": "application/json" }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async (answer) => ({ ...(await answer.json().catch(() => ({}))), status: answer.status }))`,
          answer,
        );
      const Status = Schema.Struct({ status: Schema.Number });
      const signOut = Effect.gen(function* () {
        yield* present(false);
        expect((yield* asked("/sign-out", {}, Status)).status).toBe(200);
        yield* page.evaluate(`void (location.href = "/")`);
        yield* page.until(`!!document.querySelector('[data-console-sign-in="password"]')`);
      });
      /**
       * Presses the button with someone there for what it asks. What the page asked for
       * where the address is typed was asked of an authenticator with nobody there, and
       * stays unanswered until the button calls it off.
       */
      const withPasskey = Effect.gen(function* () {
        yield* page.until(
          `performance.getEntriesByType("resource").some((one) => one.name.endsWith("/passkey/generate-authenticate-options"))`,
        );
        yield* present(true);
        yield* page.click("[data-console-sign-in-passkey]");
      });
      expect(
        (yield* until(
          "the page being there to set a password from",
          asked("/reset-password", { token, newPassword: password }, Status),
        )).status,
      ).toBe(200);
      yield* page.evaluate(`void (location.href = "/")`);
      yield* page.until(`!!document.querySelector("[data-console-sign-in-passkey]")`);
      yield* shot(page, fs, "console-sign-in-passkey");
      // Nothing chooses a theme before anyone is signed in: the page follows the browser.
      const scheme = (value: string) =>
        page.cdp.call("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value }],
        });
      yield* scheme("dark");
      yield* scheme("");
      // What is wrong with what was typed is said on a line that was kept for it: nothing
      // below a field moves from under the pointer.
      const signs = `[data-console-sign-in] button[type="submit"]`;
      const rested = yield* page.box(signs);
      yield* page.key("Enter", "Enter", ENTER);
      yield* page.until(
        `document.querySelectorAll('[data-console-sign-in] [data-slot="field-error"]').length === 2`,
      );
      expect(yield* page.box(signs)).toEqual(rested);
      yield* page.click(`[data-console-sign-in] input[name="email"]`);
      yield* page.type(email);
      yield* page.click(`[data-console-sign-in] input[name="password"]`);
      yield* page.type(password);
      yield* page.key("Enter", "Enter", ENTER);

      // The passkeys are the list of the page that tells how one signs in, below the second
      // factor, which is no list; one is named in a dialog in the window's middle.
      const dialog = (step: string) => `[data-console-security-dialog="${step}"]`;
      const passkey = (name: string) => `[data-console-passkey="${name}"]`;
      const open = Effect.gen(function* () {
        yield* page.until(`!!document.querySelector("[data-console-security]")`);
        yield* toAccount(page, "security");
        yield* page.until(`!!document.querySelector("[data-console-security-page]")`);
      });
      const add = (name: string) =>
        Effect.gen(function* () {
          yield* pressUntil(
            page,
            "[data-console-passkey-add]",
            `document.activeElement === document.querySelector('${dialog("passkey-name")} input')`,
          );
          yield* page.type(name);
          yield* page.until(
            `document.querySelector('${dialog("passkey-name")} input').value === ${JSON.stringify(name)}`,
          );
        });
      yield* open;
      yield* present(true);
      yield* page.until(
        `!!document.querySelector("[data-console-passkeys-none] [data-console-empty]")`,
      );
      // One list on the page, and what else it tells is none.
      expect(
        yield* page.evaluate(
          `document.querySelectorAll('[data-console-security-page] [data-slot="item-group"], [data-console-security-page] table').length`,
        ),
      ).toBe(0);
      yield* shot(page, fs, "console-passkeys-none");
      // One is not added without a name.
      yield* page.click("[data-console-passkey-add]");
      yield* page.until(`!!document.querySelector('${dialog("passkey-name")} input')`);
      const naming = [yield* placed(page)];
      expect(yield* stands(page)).toBe("middle");
      yield* page.key("Enter", "Enter", ENTER);
      yield* page.until(
        `!!document.querySelector('${dialog("passkey-name")} [data-slot="field-error"]')`,
      );
      naming.push(yield* placed(page));
      alike(naming);
      yield* page.click(`${dialog("passkey-name")} input`);
      yield* page.type("Laptop");
      yield* shot(page, fs, "console-passkey-name");
      yield* page.key("Enter", "Enter", ENTER);
      yield* page.until(`!!document.querySelector('${passkey("Laptop")}')`);
      yield* page.until(`!document.querySelector('${DIALOG}')`);

      // It is named anew.
      yield* page.click(`${passkey("Laptop")} [data-console-passkey-rename]`);
      yield* page.until(
        `document.activeElement === document.querySelector('${dialog("passkey-name")} input')`,
      );
      yield* page.type(" of Pia");
      yield* page.key("Enter", "Enter", ENTER);
      yield* page.until(`!!document.querySelector('${passkey("Laptop of Pia")}')`);
      yield* page.until(`!document.querySelector('${DIALOG}')`);
      expect(
        yield* page.evaluate(
          `document.querySelectorAll('[data-console-security-page] [data-slot="item-group"]').length`,
        ),
      ).toBe(1);
      yield* shot(page, fs, "console-passkeys");

      // With a second factor on, the passkey still signs in by itself: no code is asked.
      const { totpURI } = yield* asked(
        "/two-factor/enable",
        { password },
        Schema.Struct({ totpURI: Schema.String }),
      );
      expect(
        (yield* asked("/two-factor/verify-totp", { code: yield* totp(totpURI) }, Status)).status,
      ).toBe(200);
      yield* signOut;
      // Nobody is signed in by what the page asks for unasked.
      yield* Effect.sleep("1 second");
      expect(
        yield* page.evaluate(`!!document.querySelector('[data-console-sign-in="password"]')`),
      ).toBe(true);
      yield* withPasskey;
      yield* open;
      yield* page.until(`!!document.querySelector('${passkey("Laptop of Pia")}')`);

      // It is removed, once that is said again.
      yield* page.click(`${passkey("Laptop of Pia")} [data-console-passkey-remove]`);
      yield* page.until(`!!document.querySelector('${BUTTONS} button:last-child')`);
      yield* placed(page);
      yield* shot(page, fs, "console-passkey-remove");
      yield* page.click(`${BUTTONS} button:last-child`);
      yield* page.until(
        `!!document.querySelector("[data-console-passkeys-none] [data-console-empty]")`,
      );
      yield* page.until(`!document.querySelector('${DIALOG}')`);

      // An admin removes a person's passkeys without them, and none of them signs in after.
      yield* page.cdp.call("WebAuthn.clearCredentials", { authenticatorId });
      yield* add("Phone");
      yield* page.key("Enter", "Enter", ENTER);
      yield* page.until(`!!document.querySelector('${passkey("Phone")}')`);
      yield* bootstrap.accounts.removePasskeys({ params: { id: pia.id } });
      yield* signOut;
      yield* withPasskey;
      yield* page.until(`!!document.querySelector('[data-console-sign-in] [role="alert"]')`);
      expect(yield* page.text(`[data-console-sign-in] [role="alert"]`)).toBe(
        "That passkey is none of an account here.",
      );
      yield* shot(page, fs, "console-sign-in-passkey-refused");
      yield* page.cdp.call("WebAuthn.disable", {});
      expect(page.errors()).toEqual([]);
    }),
  );
});
