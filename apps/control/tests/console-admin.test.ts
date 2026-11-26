import { request } from "@aperture-browser/e2e/src/http.ts";
import { suite } from "@aperture-browser/e2e/src/suite.ts";
import * as Viewer from "@aperture-browser/e2e/src/viewer.ts";
import { until } from "@aperture-browser/e2e/src/wait.ts";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Control from "./src/control.ts";
import * as Dex from "./src/dex.ts";
import { signInThrough } from "./src/sso.ts";
import * as Proxy from "./src/proxy.ts";
import {
  BUTTONS,
  DIALOG,
  ENTER,
  ESCAPE,
  LONG,
  alike,
  choose,
  closed,
  fromMenu,
  nameToken,
  needs,
  pick,
  placed,
  pressUntil,
  rested,
  shot,
  signInWithToken,
  stands,
} from "./src/console.ts";

suite(needs)("what an admin keeps in the console, behind the proxy", (it) => {
  it.effect(
    "an admin keeps people and service accounts apart, each on a page of its own",
    () =>
      Effect.gen(function* () {
        const proxy = yield* Proxy.Proxy;
        const control = yield* Control.Control;
        const viewer = yield* Viewer.Viewer;
        const fs = yield* FileSystem.FileSystem;
        const root = yield* Control.account("Root", true);

        const page = yield* viewer.open(`${proxy.url}/api/control/openapi.json`);
        // The browser is the one the check before signed in with: nothing of that is left.
        yield* until(
          "the page being there to sign out from",
          page.evaluate(
            `(localStorage.clear(), Promise.all([fetch("/api/auth/sign-out", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), fetch("/api/control/route/cookie", { method: "DELETE" })]).then(() => true))`,
            Schema.Boolean,
          ),
        );
        yield* page.evaluate(`void (location.href = "/")`);
        yield* signInWithToken(page, root.token);

        // A person is made with a name and an address, and not without either.
        yield* page.until(`!!document.querySelector('a[href="/-/people"]')`);
        yield* page.click(`a[href="/-/people"]`);
        yield* page.until(`!!document.querySelector("[data-console-person-new]")`);
        yield* page.click("[data-console-person-new]");
        const person = "[data-console-person-create]";
        yield* page.until(`!!document.querySelector('${person} input[name="name"]')`);
        const inviting = [yield* placed(page)];
        // A person is made at the window's side, as what shows one is.
        expect(yield* stands(page)).toBe("side");
        yield* page.click(`${person} input[name="name"]`);
        yield* page.type("Lin");
        yield* page.key("Enter", "Enter", ENTER);
        yield* page.until(`!!document.querySelector('${person} [data-slot="field-error"]')`);
        inviting.push(yield* placed(page));
        alike(inviting);
        yield* shot(page, fs, "console-person-create");
        expect(
          (yield* root.api.accounts.list()).filter((account) => account.name === "Lin"),
        ).toEqual([]);
        yield* page.click(`${person} input[name="email"]`);
        yield* page.type("lin@example.test");
        yield* page.key("Enter", "Enter", ENTER);
        const lin = `[data-console-person="Lin"]`;
        yield* page.until(`!!document.querySelector('${lin}')`);
        // Whoever was made is to set a password: the link for it is shown at once.
        yield* page.until(`!!document.querySelector("[data-console-secret]")`);
        expect(yield* page.text("[data-console-secret]")).toContain(
          `email=${encodeURIComponent("lin@example.test")}`,
        );
        yield* choose(page, `${DIALOG} button`, "Done");
        // The dialogs are in the way of the row until they have closed.
        yield* page.until(
          `!document.querySelector('${person}') && !document.querySelector("[data-console-secret]")`,
        );
        // People are told apart from what is not a person, and no token is made for them here.
        expect(yield* page.evaluate(`!!document.querySelector("[data-console-service]")`)).toBe(
          false,
        );
        expect(yield* page.text(lin)).not.toContain("API token");
        // The link is among what else is done with a person, in their menu and nowhere beside it.
        expect(yield* page.evaluate(`document.querySelectorAll('${lin} button').length`)).toBe(1);
        yield* page.click(`${lin} [data-console-person-actions]`);
        yield* page.until(`!!document.querySelector('[data-console-person-action="setup-link"]')`);
        yield* rested(page);
        yield* shot(page, fs, "console-people");
        yield* page.click(`[data-console-person-action="setup-link"]`);
        yield* page.until(`!!document.querySelector("[data-console-secret]")`);
        expect(yield* page.text("[data-console-secret]")).toContain("/invite#token=");
        yield* choose(page, `${DIALOG} button`, "Done");
        yield* page.until(`!document.querySelector("[data-console-secret]")`);

        // What a person signs in with is told beside them: nothing, until they set a password.
        expect(yield* page.text(lin)).toContain("Nothing yet");
        const { token } = yield* root.api.accounts.createSetupToken({
          params: {
            id: (yield* root.api.accounts.list()).find((one) => one.name === "Lin")?.id ?? "",
          },
        });
        yield* page.evaluate(
          `fetch("/api/auth/reset-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: ${JSON.stringify(JSON.stringify({ token, newPassword: "a password of Lin's own" }))} }).then((answer) => answer.status)`,
          Schema.Number,
        );
        const does = (says: string) =>
          Effect.gen(function* () {
            yield* page.click(`${lin} [data-console-person-actions]`);
            yield* choose(page, `[data-slot="dropdown-menu-item"]`, says);
          });
        const confirmed = Effect.gen(function* () {
          yield* page.until(`!!document.querySelector('${BUTTONS} button:last-child')`);
          yield* placed(page);
          yield* page.click(`${BUTTONS} button:last-child`);
          yield* page.until(`!document.querySelector('${DIALOG}')`);
        });
        // A person is opened at the window's side: what is known of them, and below it the
        // workspaces they are in, where an admin lets them in and out and says as what.
        const linId = (yield* root.api.accounts.list()).find((one) => one.name === "Lin")?.id ?? "";
        const team = yield* root.api.workspaces.create({ payload: { name: "Team of Lin" } });
        const place = `[data-console-account-workspace="Team of Lin"]`;
        const roleOf = (accountId: string) =>
          Effect.map(
            root.api.workspaces.ofAccount({ params: { accountId } }),
            (all) => all.find((one) => one.id === team.id)?.role ?? null,
          );
        /** Lets whoever the open sheet shows into the workspace, changes what they do there, and takes them out. */
        const placedAndTaken = (accountId: string, name: string) =>
          Effect.gen(function* () {
            yield* page.until(`!!document.querySelector("[data-console-account-facts]")`);
            // Once it has come to rest where it stands.
            yield* placed(page, `${DIALOG} [data-console-account-place]`);
            expect(yield* stands(page)).toBe("side");
            expect(yield* page.text("[data-console-account-id]")).toBe(accountId);
            yield* page.until(`!!document.querySelector('${DIALOG} [data-console-empty]')`);
            const sheet = [yield* placed(page, `${DIALOG} [data-console-account-place]`)];
            // One list in it, below what is known of the account.
            expect(
              yield* page.evaluate(
                `document.querySelectorAll('${DIALOG} [data-slot="item-group"], ${DIALOG} table').length`,
              ),
            ).toBe(0);
            yield* pick(page, "[data-console-account-place-workspace]", "Team of Lin");
            yield* page.click(`[data-console-account-place] button[type="submit"]`);
            yield* page.until(`!!document.querySelector('${place}')`);
            expect(yield* roleOf(accountId)).toBe("member");
            // What they do there is said in words, and changed where it is said.
            expect(yield* page.text(`${place} [data-slot="select-value"]`)).toBe("Member");
            sheet.push(yield* placed(page, `${DIALOG} [data-console-account-place]`));
            yield* shot(page, fs, `console-account-sheet-${name}`);
            yield* pick(page, `${place} [data-slot="select-trigger"]`, "Admin");
            yield* until(
              "the role being changed",
              Effect.map(roleOf(accountId), (role) => role === "admin"),
            );
            yield* page.click(`${place} [data-console-account-unplace]`);
            yield* page.until(`document.querySelectorAll('${DIALOG}').length === 2`);
            yield* choose(page, `${BUTTONS} button`, "Remove");
            yield* page.until(`!document.querySelector('${place}')`);
            yield* page.until(`document.querySelectorAll('${DIALOG}').length === 1`);
            expect(yield* roleOf(accountId)).toBe(null);
            sheet.push(yield* placed(page, `${DIALOG} [data-console-account-place]`));
            alike(sheet);
            yield* closed(page);
          });
        // A row tells two lines of a person, and is as tall as any row that does.
        expect(
          yield* page.evaluate(`document.querySelector('${lin} td').children[0].children.length`),
        ).toBe(2);
        expect(yield* page.text(lin)).not.toContain(linId);
        expect(yield* page.text(lin)).toContain("Member");
        yield* page.click(`${lin} td`);
        yield* placedAndTaken(linId, "person");

        // Disabled, a person stays where they were, and is put in use again as they were.
        yield* does("Disable");
        yield* page.until(`!!document.querySelector('${BUTTONS} button:last-child')`);
        yield* placed(page);
        yield* shot(page, fs, "console-person-disable");
        yield* confirmed;
        yield* page.until(
          `!!document.querySelector('${lin}[data-console-person-state="disabled"]')`,
        );
        yield* page.until(
          `!!document.querySelector('${lin} [data-console-sign-in-method="password"]')`,
        );
        yield* page.click(`${lin} [data-console-person-actions]`);
        yield* page.until(`!!document.querySelector('[data-slot="dropdown-menu-item"]')`);
        yield* shot(page, fs, "console-people-disabled");
        yield* choose(page, `[data-slot="dropdown-menu-item"]`, "Enable");
        yield* page.until(`!!document.querySelector('${lin}[data-console-person-state="in-use"]')`);
        // The same is offered where the row is clicked with the other button.
        yield* page.click(`${lin} td`, "right");
        yield* page.until(`!!document.querySelector("[data-console-person-context]")`);
        expect(yield* page.text("[data-console-person-context]")).toContain("Remove passkeys");
        yield* page.key("Escape", "Escape", ESCAPE);
        yield* page.until(`!document.querySelector("[data-console-person-context]")`);
        // Deleted, they are gone.
        yield* does("Delete");
        yield* confirmed;
        yield* page.until(`!document.querySelector('${lin}')`);
        expect(
          (yield* root.api.accounts.list()).filter((account) => account.name === "Lin"),
        ).toEqual([]);

        // A service account is made with a name, and comes with tokens that are held to scopes.
        yield* page.click(`a[href="/-/service-accounts"]`);
        yield* page.until(`!!document.querySelector("[data-console-service-new]")`);
        yield* page.click("[data-console-service-new]");
        yield* page.until(`!!document.querySelector("[data-console-name-dialog] input")`);
        yield* page.click("[data-console-name-dialog] input");
        yield* page.type("Deploy bot");
        yield* shot(page, fs, "console-name");
        yield* page.key("Enter", "Enter", ENTER);
        const bot = `[data-console-service="Deploy bot"]`;
        yield* page.until(`!!document.querySelector('${bot}')`);
        yield* page.until(`!document.querySelector("[data-console-name-dialog]")`);
        expect(yield* page.evaluate(`!!document.querySelector("[data-console-person]")`)).toBe(
          false,
        );
        yield* shot(page, fs, "console-service-accounts");
        // It is let into a workspace from where it is opened: it has no address to be found by.
        const botAccount = (yield* root.api.accounts.list()).find(
          (one) => one.name === "Deploy bot",
        );
        yield* page.click(`${bot} td`);
        yield* placedAndTaken(botAccount?.id ?? "", "service");
        // Its tokens have a page of their own, reached from its row: none yet.
        const botId =
          (yield* root.api.accounts.list()).find((one) => one.name === "Deploy bot")?.id ?? "";
        const spareToken = yield* root.api.accounts.createToken({
          params: { id: botId },
          payload: { name: "spare", scopes: ["sessions:read"] },
        });
        yield* page.click(`${bot} [data-console-service-tokens]`);
        yield* page.until(`location.pathname === "/-/service-accounts/${botId}/tokens"`);
        yield* page.until(
          `document.querySelector("[data-console-crumb]")?.textContent === "Deploy bot"`,
        );
        yield* page.until(`!!document.querySelector('[data-console-token="spare"]')`);
        expect(yield* page.evaluate(`!!document.querySelector("[data-console-service]")`)).toBe(
          false,
        );
        yield* page.click("[data-console-token-new]");
        yield* page.until(`!!document.querySelector("[data-console-token-create] input")`);
        expect(yield* page.text(DIALOG)).toContain("Deploy bot");
        // The dialog is still coming to rest when its field is there: a press beside the
        // box ticks nothing, so it is pressed until it is ticked.
        yield* pressUntil(
          page,
          `[data-console-scope="sessions:write"]`,
          `document.querySelector('[data-console-scope="sessions:write"]').hasAttribute("data-checked")`,
        );
        yield* shot(page, fs, "console-service-token");
        yield* nameToken(page, "deploys");
        yield* page.until(`!!document.querySelector("[data-console-secret]")`);
        const withIt = yield* control.as((yield* page.text("[data-console-secret]")) ?? "");
        const whose = yield* withIt.accounts.current();
        expect([whose.name, whose.kind]).toEqual(["Deploy bot", "service"]);
        yield* withIt.sessions.list({ query: {} });
        expect((yield* Effect.flip(withIt.snapshots.list({ query: {} })))._tag).toBe("Forbidden");
        yield* choose(page, `${DIALOG} button`, "Done");
        yield* page.until(`!document.querySelector("[data-console-secret]")`);
        const deploys = `[data-console-token="deploys"]`;
        yield* page.until(`!!document.querySelector('${deploys}')`);
        yield* shot(page, fs, "console-service-tokens");
        // One is taken back from its row, once that is said again, and the other stays good.
        const spared = `[data-console-token="spare"]`;
        const asSpare = yield* control.as(spareToken.token);
        expect((yield* asSpare.accounts.current()).name).toBe("Deploy bot");
        yield* page.click(`${spared} [data-console-row-action="revoke"]`);
        yield* page.until(`!!document.querySelector('${BUTTONS} button:last-child')`);
        yield* placed(page);
        yield* shot(page, fs, "console-service-token-revoke");
        yield* page.click(`${BUTTONS} button:last-child`);
        yield* page.until(`!document.querySelector('${DIALOG}')`);
        yield* page.until(`!document.querySelector('${spared}')`);
        expect((yield* Effect.flip(asSpare.accounts.current()))._tag).toBe("Unauthorized");
        expect((yield* withIt.accounts.current()).name).toBe("Deploy bot");
        yield* pick(page, `[aria-label="Which tokens"]`, "Revoked or expired");
        yield* page.until(`document.querySelector('${spared}')?.textContent.includes("Revoked")`);
        expect(yield* page.evaluate(`!!document.querySelector('${deploys}')`)).toBe(false);
        expect(yield* page.evaluate(`!!document.querySelector('${spared} button')`)).toBe(false);
        yield* pick(page, `[aria-label="Which tokens"]`, "Active");
        // A right click on a row offers what its button does.
        yield* page.click(`${deploys} td`, "right");
        yield* page.until(
          `[...document.querySelectorAll('[data-slot="context-menu-item"]')].some((item) => item.textContent.includes("Revoke"))`,
        );
        yield* page.key("Escape", "Escape", ESCAPE);
        yield* page.until(`!document.querySelector('[data-slot="context-menu-item"]')`);
        // On a phone a token is a block of its own, with what is done with it in its menu.
        const narrow = yield* viewer.open(`${proxy.url}/-/service-accounts/${botId}/tokens`, {
          width: 390,
          height: 844,
          mobile: true,
        });
        yield* narrow.until(`!!document.querySelector('${deploys}')`);
        yield* narrow.click(`${deploys} [aria-label="Token actions"]`);
        yield* narrow.until(`!!document.querySelector('[data-slot="dropdown-menu-item"]')`);
        yield* shot(narrow, fs, "console-phone-service-tokens");
        expect(yield* narrow.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(
          true,
        );
        yield* narrow.close;
        // The title bar leads back to the accounts.
        yield* page.click("[data-console-crumb-back]");
        yield* page.until(`!!document.querySelector('${bot}')`);
        // It is kept out and removed as a person is: disabled, its token is nobody's.
        const doesToBot = (says: string) =>
          Effect.gen(function* () {
            yield* page.click(`${bot} [data-console-person-actions]`);
            yield* choose(page, `[data-slot="dropdown-menu-item"]`, says);
          });
        yield* doesToBot("Disable");
        yield* page.until(`!!document.querySelector('${BUTTONS} button:last-child')`);
        yield* placed(page);
        yield* shot(page, fs, "console-service-disable");
        yield* confirmed;
        yield* page.until(
          `!!document.querySelector('${bot}[data-console-service-state="disabled"]')`,
        );
        expect((yield* Effect.flip(withIt.accounts.current()))._tag).toBe("Unauthorized");
        yield* page.click(`${bot} td`, "right");
        yield* page.until(`!!document.querySelector("[data-console-person-context]")`);
        expect(yield* page.text("[data-console-person-context]")).toContain("API tokens");
        yield* shot(page, fs, "console-service-accounts-disabled");
        yield* choose(page, `[data-slot="context-menu-item"]`, "Enable");
        yield* page.until(
          `!!document.querySelector('${bot}[data-console-service-state="in-use"]')`,
        );
        expect((yield* withIt.accounts.current()).name).toBe("Deploy bot");
        yield* doesToBot("Delete");
        yield* confirmed;
        yield* page.until(`!document.querySelector('${bot}')`);

        // What lets nodes register is kept apart from the nodes.
        yield* root.api.nodes.createRegistrationToken({ payload: { name: "spare" } });
        yield* page.click(`a[href="/-/registration-tokens"]`);
        yield* page.until(`!!document.querySelector('[data-console-registration-token="checks"]')`);
        expect(yield* page.evaluate(`!!document.querySelector("[data-console-node]")`)).toBe(false);
        yield* shot(page, fs, "console-registration-tokens");
        // One is taken back from its row's menu, once that is said again, and is kept among
        // those that were.
        const spare = `[data-console-registration-token="spare"]`;
        const which = `[aria-label="Which tokens"]`;
        yield* page.click(`${spare} [aria-label="Token actions"]`);
        yield* choose(page, `[data-slot="dropdown-menu-item"]`, "Revoke");
        yield* page.until(`!!document.querySelector('${BUTTONS} button:last-child')`);
        yield* placed(page);
        yield* shot(page, fs, "console-registration-token-revoke");
        yield* confirmed;
        yield* page.until(`!document.querySelector('${spare}')`);
        yield* pick(page, which, "Revoked");
        yield* page.until(`document.querySelector('${spare}')?.textContent.includes("Revoked")`);
        expect(
          yield* page.evaluate(
            `!!document.querySelector('[data-console-registration-token="checks"]')`,
          ),
        ).toBe(false);
        // Nothing is left to do with it.
        expect(yield* page.evaluate(`!!document.querySelector('${spare} button')`)).toBe(false);
        yield* shot(page, fs, "console-registration-tokens-revoked");
        // A right click on a row offers what its menu does.
        yield* pick(page, which, "Active");
        const row = yield* page.box(`[data-console-registration-token="checks"]`);
        yield* page.clickAt(row.x, row.y, "right");
        yield* page.until(
          `[...document.querySelectorAll('[data-slot="context-menu-item"]')].some((item) => item.textContent.includes("Revoke"))`,
        );
        yield* shot(page, fs, "console-registration-token-context");
        yield* page.key("Escape", "Escape", ESCAPE);
        yield* page.until(`!document.querySelector('[data-slot="context-menu-item"]')`);
        // On a phone a token is a block of its own, with what is done with it in its menu.
        const phone = yield* viewer.open(`${proxy.url}/-/registration-tokens`, {
          width: 390,
          height: 844,
          mobile: true,
        });
        yield* phone.until(
          `!!document.querySelector('[data-console-registration-token="checks"]')`,
        );
        yield* phone.click(
          `[data-console-registration-token="checks"] [aria-label="Token actions"]`,
        );
        yield* phone.until(`!!document.querySelector('[data-slot="dropdown-menu-item"]')`);
        yield* shot(phone, fs, "console-phone-registration-tokens");
        expect(yield* phone.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(
          true,
        );
        yield* phone.close;
        yield* page.click(`a[href="/-/nodes"]`);
        yield* page.until(`!!document.querySelector("[data-console-node]")`);
        expect(
          yield* page.evaluate(`!!document.querySelector("[data-console-registration-token]")`),
        ).toBe(false);
        yield* shot(page, fs, "console-nodes");
        expect(page.errors()).toEqual([]);
      }),
    // Longer than a check gets where the machine is busy with something else.
    LONG,
  );

  it.effect(
    "an admin adds a sign-in provider in the console, checks it, disables it and removes it",
    () =>
      Effect.gen(function* () {
        const proxy = yield* Proxy.Proxy;
        const control = yield* Control.Control;
        const viewer = yield* Viewer.Viewer;
        const fs = yield* FileSystem.FileSystem;
        const dex = yield* Dex.Address;
        const root = yield* Control.account("Provider admin", true);
        const [added] = Dex.ADDED;
        const offered = Effect.map(
          request(control.url, "", "GET", "/api/control/sign-in/providers"),
          (answer) => JSON.stringify(answer.body),
        );

        const page = yield* viewer.open(`${proxy.url}/api/control/openapi.json`);
        yield* until(
          "the page being there to sign out from",
          page.evaluate(
            `(localStorage.clear(), Promise.all([fetch("/api/auth/sign-out", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), fetch("/api/control/route/cookie", { method: "DELETE" })]).then(() => true))`,
            Schema.Boolean,
          ),
        );
        yield* page.evaluate(`void (location.href = "/")`);
        yield* signInWithToken(page, root.token);

        // The provider the settings name is told among them, and nothing is done with it here.
        yield* page.until(`!!document.querySelector('a[href="/-/sign-in-providers"]')`);
        yield* page.click(`a[href="/-/sign-in-providers"]`);
        const configured = `[data-console-provider="${Dex.PROVIDER}"]`;
        yield* page.until(`!!document.querySelector('${configured}')`);
        expect(yield* page.text(configured)).toContain("From configuration");
        expect(yield* page.evaluate(`!!document.querySelector('${configured} button')`)).toBe(
          false,
        );

        const form = "[data-console-provider-form]";
        const reached = (state: string) =>
          page.until(`!!document.querySelector('[data-console-provider-reached="${state}"]')`);
        /** Types into a field of the form, and sees it there before anything else is done. */
        const fill = (name: string, text: string) =>
          Effect.gen(function* () {
            const field = `document.querySelector('${form} input[name="${name}"]')`;
            yield* page.evaluate(`void ${field}.scrollIntoView({ block: "nearest" })`);
            yield* rested(page);
            yield* page.click(`${form} input[name="${name}"]`);
            yield* page.until(`document.activeElement === ${field}`);
            // In place of what a preset put there.
            yield* page.evaluate(`void ${field}.select()`);
            yield* page.type(text);
            yield* page.until(`${field}.value === ${JSON.stringify(text)}`);
          });
        const typed = (name: string) =>
          page.evaluate(`document.querySelector('${form} input[name="${name}"]').value`);
        /** The scopes that are chosen, as the form shows them. */
        const scopes = page.evaluate(
          `[...document.querySelectorAll('${form} [data-scope]')].map((one) => one.dataset.scope).join(" ")`,
        );
        const opened = Effect.gen(function* () {
          yield* page.click("[data-console-provider-new]");
          yield* page.until(`!!document.querySelector('${form} input[name="name"]')`);
          yield* rested(page);
          return yield* placed(page);
        });

        // What is no provider is said to be none in the field itself, and why opens beside
        // it: nothing moves.
        const states = [yield* opened];
        yield* fill("issuer", `${control.url}/nowhere`);
        yield* page.click("[data-console-provider-check]");
        yield* reached("refused");
        yield* page.until(`!!document.querySelector("[data-console-provider-problems]")`);
        expect(yield* page.text("[data-console-provider-problems]")).toContain("/nowhere");
        states.push(yield* placed(page));
        yield* shot(page, fs, "console-provider-check-refused");
        // Escape closes what is open above the form first, and then the form.
        yield* page.key("Escape", "Escape", ESCAPE);
        yield* page.until(`!document.querySelector("[data-console-provider-problems]")`);
        expect(yield* page.text("[data-console-provider-reached]")).toContain("Not reached");
        yield* closed(page);

        // Begun anew, the form is empty. A provider that is known fills in what is known
        // of it: what it is called and known by, and what is asked of it.
        states.push(yield* opened);
        expect(yield* typed("issuer")).toBe("");
        yield* pick(page, "[data-console-provider-preset]", "Keycloak");
        yield* page.until(`!!document.querySelector('${form} input[name="parts.realm"]')`);
        expect([yield* typed("name"), yield* typed("id")]).toEqual(["Keycloak", "keycloak"]);
        // Its issuer is made of what is its own there, and is not typed.
        yield* fill("parts.base", "https://sso.example.test/");
        yield* fill("parts.realm", "people");
        expect(yield* typed("issuer")).toBe("https://sso.example.test/realms/people");
        // One that speaks OAuth 2.0 alone has no issuer: where it is asked is its own, and
        // so is what is asked of it.
        yield* pick(page, "[data-console-provider-preset]", "GitHub");
        yield* page.until(`!!document.querySelector('${form} input[name="authorization"]')`);
        expect([yield* typed("name"), yield* typed("id"), yield* typed("authorization")]).toEqual([
          "GitHub",
          "github",
          "https://github.com/login/oauth/authorize",
        ]);
        expect(yield* scopes).toBe("read:user user:email");
        yield* pick(page, "[data-console-provider-preset]", "Dex");
        yield* page.until(`!!document.querySelector('${form} input[name="issuer"]')`);
        // Each that is known is offered with its own mark, and chosen with it.
        expect(
          yield* page.evaluate(
            `!!document.querySelector('[data-console-provider-preset] [data-provider-mark="dex"]')`,
          ),
        ).toBe(true);
        expect([yield* typed("name"), yield* typed("id"), yield* typed("issuer")]).toEqual([
          "Dex",
          "dex",
          "",
        ]);
        expect(yield* scopes).toBe("openid email profile");
        // The address to register follows the id as typed.
        yield* fill("name", "Company");
        yield* fill("id", added);
        expect(
          yield* page.evaluate(`document.querySelector("[data-console-provider-callback]").value`),
        ).toBe(`${proxy.url}/api/auth/callback/${added}`);
        yield* fill("issuer", dex.issuer);
        yield* page.click("[data-console-provider-check]");
        yield* reached("reached");
        // Reached, it offers the scopes it says it gives; one it does not say is typed.
        // Nothing is typed into the field: pressed, it opens the list, whose own field is
        // typed into.
        const picker = `${form} [data-slot="scopes-picker"]`;
        expect(yield* page.evaluate(`!!document.querySelector('${picker} input')`)).toBe(false);
        yield* page.evaluate(
          `void document.querySelector('${picker}').scrollIntoView({ block: "center" })`,
        );
        yield* rested(page);
        yield* pressUntil(page, picker, `document.querySelector('[data-scope-option="groups"]')`);
        expect(
          yield* page.evaluate(
            `!!document.querySelector('[data-scope-option="openid"][data-disabled]')`,
          ),
        ).toBe(true);
        yield* rested(page);
        yield* pressUntil(
          page,
          `[data-scope-option="groups"]`,
          `document.querySelector('${form} [data-scope="groups"]')`,
        );
        yield* page.until(
          `document.activeElement === document.querySelector('[data-slot="combobox-content"] input')`,
        );
        yield* page.type("federated:id");
        yield* page.until(
          `!!document.querySelector('[data-scope-option="federated:id"][data-scope-typed]')`,
        );
        yield* rested(page);
        yield* shot(page, fs, "console-provider-scopes");
        yield* page.key("Enter", "Enter", ENTER);
        yield* page.until(`!!document.querySelector('${form} [data-scope="federated:id"]')`);
        // Escape closes the list where it is still open, and nothing else: the form stays,
        // with what was chosen.
        const listed = `!!document.querySelector('[data-slot="combobox-content"][data-open]')`;
        if (yield* page.evaluate(listed, Schema.Boolean)) {
          yield* page.key("Escape", "Escape", ESCAPE);
          yield* page.until(`!(${listed})`);
        }
        expect(yield* scopes).toBe("openid email profile groups federated:id");
        yield* page.evaluate(
          `void document.querySelector('${form} input[name="name"]').scrollIntoView({ block: "center" })`,
        );
        yield* rested(page);
        states.push(yield* placed(page));
        yield* shot(page, fs, "console-provider-new");
        // Without a client, it is not sent, and is told what it lacks where it stays.
        yield* page.click(`${BUTTONS} button[type="submit"]`);
        yield* page.until(`!!document.querySelector('${form} [data-slot="field-error"]')`);
        states.push(yield* placed(page));
        alike(states);
        yield* fill("clientId", dex.clientId);
        yield* fill("clientSecret", dex.clientSecret);
        yield* page.key("Enter", "Enter", ENTER);
        const row = `[data-console-provider="${added}"]`;
        yield* page.until(
          `!document.querySelector('${DIALOG}') && !!document.querySelector('${row}')`,
        );
        expect(yield* offered).toContain(`"id":"${added}"`);
        // Someone an admin made a person signs in through it, with the scopes it was given.
        const [, , carol] = Dex.VERIFIED;
        const bootstrap = yield* control.as(control.bootstrapToken);
        yield* bootstrap.accounts.create({ payload: { name: "Carol", email: carol.email } });
        const landed = yield* signInThrough(proxy.url, "local", carol.email, undefined, added);
        expect(landed.at).toBe("/-/sessions");
        // The secret is nowhere on the page once it was given.
        expect(
          yield* page.evaluate(
            `document.body.innerHTML.includes(${JSON.stringify(dex.clientSecret)})`,
          ),
        ).toBe(false);
        // It is shown with the mark of the provider it was made from, here and to whoever
        // signs in; the one the settings name said none, and has none of any provider's.
        expect(
          yield* page.evaluate(`!!document.querySelector('${row} [data-provider-mark="dex"]')`),
        ).toBe(true);
        expect(
          yield* page.evaluate(`!!document.querySelector('${configured} [data-provider-mark=""]')`),
        ).toBe(true);
        expect(yield* offered).toMatch(new RegExp(`"id":"${added}"[^}]*"icon":"dex"`, "u"));
        yield* rested(page);
        yield* shot(page, fs, "console-providers");

        // Its row's menu disables it, and a right click on the row enables it again.
        const does = (says: string) =>
          Effect.gen(function* () {
            yield* rested(page);
            yield* page.click(`${row} [aria-label="Provider actions"]`);
            yield* choose(page, `[data-slot="dropdown-menu-item"]`, says);
          });
        const state = (is: string) =>
          page.until(`!!document.querySelector('${row} [data-console-provider-state="${is}"]')`);
        yield* does("Disable");
        yield* state("disabled");
        expect(yield* offered).not.toContain(`"id":"${added}"`);
        yield* rested(page);
        const at = yield* page.box(row);
        yield* page.clickAt(at.x, at.y, "right");
        yield* page.until(
          `[...document.querySelectorAll('[data-slot="context-menu-item"]')].some((item) => item.textContent.includes("Enable"))`,
        );
        yield* shot(page, fs, "console-provider-context");
        yield* choose(page, `[data-slot="context-menu-item"]`, "Enable");
        yield* state("enabled");
        expect(yield* offered).toContain(`"id":"${added}"`);

        // Changed, it keeps what it is known by and its secret, which is not shown.
        yield* does("Edit");
        yield* page.until(`!!document.querySelector('${form} input[name="id"]')`);
        yield* rested(page);
        expect(
          yield* page.evaluate(
            `(() => { const form = document.querySelector('${form}'); return [form.querySelector('input[name="id"]').disabled, form.querySelector('input[name="id"]').value, form.querySelector('input[name="clientSecret"]').value, form.querySelector('input[name="clientSecret"]').placeholder].join("|"); })()`,
          ),
        ).toBe(`true|${added}||Unchanged`);
        // What was asked of it is what it is asked for still.
        expect(yield* scopes).toBe("openid email profile groups federated:id");
        alike([states[0], yield* placed(page)]);
        yield* shot(page, fs, "console-provider-edit");
        yield* closed(page);

        // On a phone a provider is a block of its own, and its form fits the screen.
        const phone = yield* viewer.open(`${proxy.url}/-/sign-in-providers`, {
          width: 390,
          height: 844,
          mobile: true,
        });
        yield* phone.until(`!!document.querySelector('${row}')`);
        yield* rested(phone);
        yield* shot(phone, fs, "console-phone-providers");
        expect(yield* phone.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(
          true,
        );
        yield* phone.click(`${row} [aria-label="Provider actions"]`);
        yield* choose(phone, `[data-slot="dropdown-menu-item"]`, "Edit");
        yield* phone.until(`!!document.querySelector('${form} input[name="id"]')`);
        yield* rested(phone);
        yield* shot(phone, fs, "console-phone-provider-edit");
        expect(yield* phone.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(
          true,
        );
        yield* phone.close;

        // Removed once that is said again, it is gone from the page and from who is offered.
        yield* does("Remove");
        yield* page.until(`!!document.querySelector('${BUTTONS} button:last-child')`);
        yield* placed(page);
        yield* shot(page, fs, "console-provider-remove");
        yield* page.click(`${BUTTONS} button:last-child`);
        yield* page.until(`!document.querySelector('${row}')`);
        expect(yield* offered).not.toContain(`"id":"${added}"`);
        expect(yield* page.evaluate(`!!document.querySelector('${configured}')`)).toBe(true);
        expect(page.errors()).toEqual([]);
      }),
    LONG,
  );

  it.effect("the console offers a token what it is for, and nothing the API would refuse it", () =>
    Effect.gen(function* () {
      const proxy = yield* Proxy.Proxy;
      const control = yield* Control.Control;
      const viewer = yield* Viewer.Viewer;
      const fs = yield* FileSystem.FileSystem;
      const owner = yield* Control.account("Owner", true);
      const team = yield* owner.api.workspaces.create({ payload: { name: "Team of the held" } });
      const own = yield* until(
        "a session on the node that registered",
        owner.api.sessions.create({ payload: { suspended: true, label: "Owner's own" } }),
        "30 seconds",
      );
      const shared = yield* owner.api.sessions.create({
        payload: { suspended: true, label: "The team's", workspaceId: team.id },
      });
      const reader = yield* owner.api.accounts.createOwnToken({
        payload: { name: "reader", scopes: ["sessions:read"] },
      });
      const held = yield* owner.api.accounts.createOwnToken({
        payload: {
          name: "held",
          scopes: ["sessions:write", "snapshots:write"],
          resources: { workspaces: [team.id], sessions: [], snapshots: [] },
        },
      });

      const page = yield* viewer.open(`${proxy.url}/api/control/openapi.json`);
      // Whoever was signed in before is not, and a token is given in their place.
      const signIn = (token: string) =>
        Effect.gen(function* () {
          yield* until(
            "the page being there to sign out from",
            page.evaluate(
              `(localStorage.clear(), Promise.all([fetch("/api/auth/sign-out", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), fetch("/api/control/route/cookie", { method: "DELETE" })]).then(() => true))`,
              Schema.Boolean,
            ),
          );
          yield* page.evaluate(`void (location.href = "/")`);
          yield* signInWithToken(page, token);
          yield* page.until(`!!document.querySelector('a[href="/-/workspaces"]')`);
          yield* page.evaluate(`void performance.setResourceTimingBufferSize(2000)`);
        });
      const has = (selector: string) =>
        page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`, Schema.Boolean);
      const menuOf = (card: string) =>
        Effect.gen(function* () {
          yield* page.click(`${card} [aria-label="Session actions"]`);
          yield* page.until(`!!document.querySelector('[data-slot="dropdown-menu-item"]')`);
          return yield* page.evaluate(
            `[...document.querySelectorAll('[data-slot="dropdown-menu-item"]')].map((item) => item.textContent.trim())`,
            Schema.Array(Schema.String),
          );
        });
      /** What the page asked of the API and was refused, since it was last loaded. */
      const refused = page.evaluate(
        `performance.getEntriesByType("resource").filter((asked) => asked.responseStatus === 403).map((asked) => new URL(asked.name).pathname)`,
        Schema.Array(Schema.String),
      );
      const menuClosed = Effect.gen(function* () {
        yield* page.key("Escape", "Escape", ESCAPE);
        yield* page.until(`!document.querySelector('[data-slot="dropdown-menu-item"]')`);
      });

      // A token that reads sessions sees them, and is offered nothing that changes one.
      yield* signIn(reader.token);
      const ownCard = `[data-console-session="${own.id}"]`;
      yield* page.until(`!!document.querySelector('${ownCard}')`);
      expect(yield* has("[data-console-create]")).toBe(false);
      expect(yield* has(`${ownCard} input[type="checkbox"]`)).toBe(false);
      // It is an admin's, and not for what an admin does, nor for anything else there is.
      for (const gone of ["snapshots", "account", "people", "nodes", "audit"]) {
        expect([gone, yield* has(`a[href="/-/${gone}"]`)]).toEqual([gone, false]);
      }
      expect(yield* menuOf(ownCard)).toEqual(["Open", "Copy link", "Details", "Settings"]);
      yield* shot(page, fs, "console-held-reader");
      yield* menuClosed;
      yield* page.click(`${ownCard} [data-console-session-footer]`, "right");
      yield* page.until(`!!document.querySelector("[data-console-session-context]")`);
      expect(yield* page.text("[data-console-session-context]")).not.toContain("Delete");
      yield* page.key("Escape", "Escape", ESCAPE);
      yield* page.until(`!document.querySelector("[data-console-session-context]")`);
      // Workspaces are told to all; who is in one, and making and changing one, is for a
      // token that is for it.
      yield* page.click(`a[href="/-/workspaces"]`);
      const row = `[data-console-workspace="Team of the held"]`;
      yield* page.until(`!!document.querySelector('${row}')`);
      expect(yield* has("[data-console-workspace-new]")).toBe(false);
      expect(yield* has(`${row} [data-console-row-action="members"]`)).toBe(false);
      expect(yield* has(`${row} [data-console-row-actions]`)).toBe(false);
      yield* shot(page, fs, "console-held-reader-workspaces");
      // A page that is not the token's says so, where its address is come to.
      yield* page.evaluate(
        `void (history.pushState({}, "", "/-/account/tokens"), dispatchEvent(new PopStateEvent("popstate")))`,
      );
      yield* page.until(`!!document.querySelector('[data-console-not-allowed="tokens:write"]')`);
      yield* shot(page, fs, "console-held-not-allowed");
      const phone = yield* viewer.open(`${proxy.url}/-/sessions`, {
        width: 390,
        height: 844,
        mobile: true,
      });
      yield* phone.until(`!!document.querySelector('${ownCard}')`);
      expect(yield* phone.evaluate(`!!document.querySelector("[data-console-create]")`)).toBe(
        false,
      );
      yield* shot(phone, fs, "console-phone-held-reader");
      expect(yield* phone.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(
        true,
      );
      yield* phone.close;
      // Nothing was asked of the API that it refuses this token.
      expect(yield* refused).toEqual([]);
      expect(page.errors()).toEqual([]);

      // A token held to a workspace sees what is there, and makes sessions there alone.
      yield* signIn(held.token);
      yield* page.until(`!!document.querySelector("[data-console-empty]")`);
      expect(yield* has(ownCard)).toBe(false);
      expect(yield* has("[data-console-create]")).toBe(false);
      yield* shot(page, fs, "console-held-personal");
      yield* page.click("[data-console-workspace-switcher]");
      yield* choose(page, `[data-slot="dropdown-menu-radio-item"]`, "Team of the held");
      const sharedCard = `[data-console-session="${shared.id}"]`;
      yield* page.until(`!!document.querySelector('${sharedCard}')`);
      // The list stays for another choice, and is in the way of what is under it.
      yield* page.key("Escape", "Escape", ESCAPE);
      yield* page.until(`!document.querySelector('[data-slot="dropdown-menu-radio-item"]')`);
      yield* page.until(`!!document.querySelector("[data-console-create]")`);
      expect(yield* has(`a[href="/-/snapshots"]`)).toBe(true);
      expect(yield* has(`a[href="/-/account"]`)).toBe(false);
      const offered = yield* menuOf(sharedCard);
      expect(offered).toEqual(expect.arrayContaining(["Share", "Save to snapshot", "Delete"]));
      yield* shot(page, fs, "console-held-workspace");
      yield* menuClosed;
      // Its own server is told of with no token to make for it: this one makes none.
      yield* fromMenu(page, sharedCard, "Details");
      yield* closed(page);
      expect(yield* refused).toEqual([]);
      expect(page.errors()).toEqual([]);

      yield* Effect.forEach([own.id, shared.id], (id) =>
        owner.api.sessions.delete({ params: { id } }),
      );
      expect((yield* (yield* control.as(reader.token)).accounts.current()).scopes).toEqual([
        "sessions:read",
      ]);
    }),
  );

  it.effect(
    "an admin is shown the workspaces they are in, the others when they ask, and acts in one once they join it",
    () =>
      Effect.gen(function* () {
        const proxy = yield* Proxy.Proxy;
        const viewer = yield* Viewer.Viewer;
        const fs = yield* FileSystem.FileSystem;
        const looker = yield* Control.account("Looker", true);
        const keeper = yield* Control.account("Keeper");
        const control = yield* Control.Control;
        const plain = yield* (yield* control.as(control.bootstrapToken)).accounts.create({
          payload: { name: "Plain", kind: "person", email: "plain@example.test" },
        });
        const apart = yield* keeper.api.workspaces.create({ payload: { name: "Kept apart" } });
        yield* keeper.api.workspaces.admit({
          params: { id: apart.id, accountId: plain.id },
          payload: { role: "member" },
        });
        const theirs = yield* until(
          "a session on the node that registered",
          keeper.api.sessions.create({
            payload: { suspended: true, label: "Keeper's", workspaceId: apart.id },
          }),
          "30 seconds",
        );

        const page = yield* viewer.open(`${proxy.url}/api/control/openapi.json`);
        yield* until(
          "the page being there to sign out from",
          page.evaluate(
            `(localStorage.clear(), Promise.all([fetch("/api/auth/sign-out", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), fetch("/api/control/route/cookie", { method: "DELETE" })]).then(() => true))`,
            Schema.Boolean,
          ),
        );
        yield* page.evaluate(`void (location.href = "/")`);
        yield* signInWithToken(page, looker.token);
        yield* page.until(`!!document.querySelector('a[href="/-/workspaces"]')`);
        yield* page.click(`a[href="/-/workspaces"]`);
        const has = (selector: string) =>
          page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`, Schema.Boolean);

        // By itself the page has the workspaces they are in; the others, once asked for.
        const row = `[data-console-workspace="Kept apart"]`;
        const shown = `[data-slot="select-trigger"][aria-label="Shown"]`;
        // They are in none, and are told so.
        yield* page.until(`!!document.querySelector('${shown}')`);
        yield* page.until(`!!document.querySelector("[data-console-empty]")`);
        expect(yield* has(row)).toBe(false);
        yield* pick(page, shown, "All workspaces");
        yield* page.until(`!!document.querySelector('${row} [data-console-workspace-onlooked]')`);
        expect(yield* page.text(row)).toContain("Not a member · read only");
        expect(yield* has(`${row} [data-console-row-action="join"]`)).toBe(true);
        yield* shot(page, fs, "console-workspaces-every");
        // It is kept by the browser, and the switcher has the same.
        yield* page.evaluate(`void location.reload()`);
        yield* page.until(`!!document.querySelector('${row}')`);
        expect(yield* page.text(shown)).toContain("All workspaces");

        const others = "[data-console-workspace-others]";
        yield* page.click("[data-console-workspace-switcher]");
        yield* page.until(`!!document.querySelector('${others}')`);
        expect(yield* page.text(others)).toContain("Kept apart");
        yield* shot(page, fs, "console-switcher-every");
        yield* page.click("[data-console-workspace-every]");
        yield* page.until(`!document.querySelector('${others}')`);
        yield* page.click("[data-console-workspace-every]");
        yield* page.until(`!!document.querySelector('${others}')`);
        yield* choose(page, `[role="menuitemradio"]`, "Kept apart");
        yield* page.key("Escape", "Escape", ESCAPE);
        yield* page.until(`!document.querySelector('[role="menuitemradio"]')`);
        yield* page.until(`!!document.querySelector("[data-console-workspace-onlooked]")`);
        // With the others hidden, the one that is selected stays where it is chosen from.
        yield* page.click("[data-console-workspace-switcher]");
        yield* page.click("[data-console-workspace-every]");
        yield* page.until(
          `!document.querySelector('[data-console-workspace-every][data-checked]') && !!document.querySelector('${others}')`,
        );
        expect(yield* page.text(others)).toContain("Kept apart");
        yield* page.key("Escape", "Escape", ESCAPE);
        yield* page.until(`!document.querySelector('[role="menuitemradio"]')`);

        // What is there is seen, and nothing that acts is offered: joining is.
        yield* page.click(`a[href="/-/sessions"]`);
        const card = `[data-console-session="${theirs.id}"]`;
        yield* page.until(`!!document.querySelector('${card}')`);
        yield* page.until(`!!document.querySelector("[data-console-onlooked-note]")`);
        expect(yield* has("[data-console-create]")).toBe(false);
        expect(yield* has(`${card} input[type="checkbox"]`)).toBe(false);
        yield* page.click(`${card} [aria-label="Session actions"]`);
        yield* page.until(`!!document.querySelector('[data-slot="dropdown-menu-item"]')`);
        expect(
          yield* page.evaluate(
            `[...document.querySelectorAll('[data-slot="dropdown-menu-item"]')].map((item) => item.textContent.trim())`,
            Schema.Array(Schema.String),
          ),
        ).toEqual(["Open", "Copy link", "Details", "Settings"]);
        yield* shot(page, fs, "console-workspace-onlooked");
        yield* page.key("Escape", "Escape", ESCAPE);
        yield* page.until(`!document.querySelector('[data-slot="dropdown-menu-item"]')`);

        yield* page.click("[data-console-workspace-join]");
        yield* page.until(
          `!document.querySelector("[data-console-onlooked-note]") && !!document.querySelector("[data-console-create]")`,
        );
        expect(yield* has("[data-console-workspace-onlooked]")).toBe(false);
        expect((yield* looker.api.workspaces.list()).find((one) => one.id === apart.id)?.role).toBe(
          "member",
        );
        expect(page.errors()).toEqual([]);

        // What sessions are held to, at each level, for whoever looks at the pictures.
        yield* fromMenu(page, card, "Settings");
        yield* page.until(
          `!!document.querySelector('[data-console-settings="session"] [data-console-setting]')`,
        );
        yield* placed(page, DIALOG);
        yield* shot(page, fs, "console-settings-session");
        yield* closed(page);
        const settingsAt = (path: string, level: string, name = level) =>
          Effect.gen(function* () {
            yield* page.evaluate(
              `void (history.pushState({}, "", ${JSON.stringify(path)}), dispatchEvent(new PopStateEvent("popstate")))`,
            );
            yield* page.until(
              `!!document.querySelector('[data-console-settings="${level}"] [data-console-setting]')`,
            );
            yield* shot(page, fs, `console-settings-${name}`);
          });
        yield* settingsAt(`/-/workspaces/${apart.id}/settings`, "workspace");
        // The workspace they joined is the one selected: theirs as a member of it.
        yield* settingsAt("/-/account/settings", "member", "account");
        yield* settingsAt("/-/settings", "instance");
        // A change is made where the setting is, and waits to be saved with the others.
        const aged = `[data-console-setting="maxSessionAge"]`;
        yield* pick(page, `${aged} [data-slot="select-trigger"][aria-label="Mode"]`, "Override");
        yield* page.click(`${aged} [aria-label="More"]`);
        // The bounds of the levels below are said under the value, in the row.
        const idle = `[data-console-setting="suspendIdleAfter"]`;
        yield* page.click(`${idle} [data-console-setting-limit]`);
        yield* page.click(`${idle} input[aria-label="Most below"]`);
        yield* page.type("8");
        yield* page.until(`!!document.querySelector("[data-console-settings-save]")`);
        expect(yield* page.text("[data-console-settings-save]")).toContain("2 unsaved changes");
        yield* page.until(
          `document.querySelector("[data-console-settings-save]")?.getAnimations().every((one) => one.playState === "finished")`,
        );
        yield* shot(page, fs, "console-settings-unsaved");
        yield* page.click("[data-console-settings-discard]");
        yield* page.until(`!document.querySelector("[data-console-settings-save]")`);
        expect(page.errors()).toEqual([]);

        // What an admin says of one person, from their row among the people.
        const person = { accountId: plain.id };
        yield* looker.api.settings.setPerson({
          params: { ...person, key: "runningSessions" },
          payload: { value: 2, min: 2, max: 2 },
        });
        yield* looker.api.settings.setPerson({
          params: { ...person, key: "maxSessionAge" },
          payload: { max: 604_800 },
        });
        yield* page.click(`a[href="/-/people"]`);
        yield* page.click(`[data-console-person="Plain"] [data-console-person-actions]`);
        yield* page.click(`[data-console-person-action="settings"]`);
        const running = `[data-console-settings="account"] [data-console-setting="runningSessions"]`;
        yield* page.until(`!!document.querySelector('${running}')`);
        // A value held from both ends is enforced: the levels below take nothing else.
        expect(yield* page.text(running)).toContain("Enforce");
        yield* shot(page, fs, "console-settings-person");

        // And what an admin of a workspace says of one of its members there, from its members.
        yield* keeper.api.settings.setMember({
          params: { id: apart.id, ...person, key: "clipboard" },
          payload: { value: "ro", allowed: ["ro", "off"] },
        });
        yield* page.click(`a[href="/-/workspaces"]`);
        yield* page.click(
          `[data-console-workspace="Kept apart"] [data-console-row-action="members"]`,
        );
        yield* page.click(`[data-console-member="Plain"] [data-console-member-settings]`);
        yield* page.until(
          `!!document.querySelector('[data-console-settings="member"] [data-console-setting="clipboard"]')`,
        );
        yield* page.until(`!document.querySelector('${DIALOG}')`);
        // Of what the person has as a member, the levels above are said where they hold it.
        expect(yield* page.text(`[data-console-setting="runningSessions"]`)).toContain(
          "Locked by the user",
        );
        yield* shot(page, fs, "console-settings-member");
        expect(page.errors()).toEqual([]);

        // The person reads what was said for them and by whom, and says their own values alone.
        const plainToken = yield* (yield* control.as(control.bootstrapToken)).accounts.createToken({
          params: { id: plain.id },
          payload: { name: "checks", scopes: Control.ALL_SCOPES },
        });
        yield* until(
          "the page being there to sign out from",
          page.evaluate(
            `(localStorage.clear(), Promise.all([fetch("/api/auth/sign-out", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), fetch("/api/control/route/cookie", { method: "DELETE" })]).then(() => true))`,
            Schema.Boolean,
          ),
        );
        yield* page.evaluate(`void (location.href = "/-/account/settings")`);
        yield* signInWithToken(page, plainToken.token);
        // Their own first, of no workspace; then theirs in the workspace, once it is selected.
        yield* page.until(
          `!!document.querySelector('[data-console-settings="account"] [data-console-setting="clipboard"]')`,
        );
        yield* page.click("[data-console-workspace-switcher]");
        yield* choose(page, `[role="menuitemradio"]`, "Kept apart");
        yield* page.key("Escape", "Escape", ESCAPE);
        yield* page.until(`!document.querySelector('[role="menuitemradio"]')`);
        yield* page.until(
          `!!document.querySelector('[data-console-settings="member"] [data-console-setting="clipboard"]')`,
        );
        expect(yield* page.text(`[data-console-setting="runningSessions"]`)).toContain(
          "Locked by an admin",
        );
        expect(yield* page.text(`[data-console-setting="clipboard"]`)).toContain(
          "by a workspace admin",
        );
        expect(
          yield* page.evaluate(`!!document.querySelector("[data-console-setting-limit]")`),
        ).toBe(false);
        yield* shot(page, fs, "console-settings-own");
        expect(page.errors()).toEqual([]);

        // The workspace stays: the check of the events after this one counts those deleted.
        yield* looker.api.sessions.delete({ params: { id: theirs.id } });
      }),
    LONG,
  );

  it.effect(
    "an admin reads what was done on the page of events, by its kind and by who did it",
    () =>
      Effect.gen(function* () {
        const proxy = yield* Proxy.Proxy;
        const viewer = yield* Viewer.Viewer;
        const fs = yield* FileSystem.FileSystem;
        const auditor = yield* Control.account("Auditor", true);
        const quill = yield* Control.account("Quill");
        // More than a page of events, one about what is still there and one about what is gone.
        yield* Effect.forEach(
          Array.from({ length: 52 }, (_, at) => `token ${at}`),
          (name) =>
            auditor.api.accounts.createOwnToken({ payload: { name, scopes: ["events:read"] } }),
          { discard: true },
        );
        yield* quill.api.workspaces.create({ payload: { name: "Kept workspace" } });
        const gone = yield* auditor.api.workspaces.create({ payload: { name: "Gone workspace" } });
        yield* auditor.api.workspaces.delete({ params: { id: gone.id } });

        const page = yield* viewer.open(`${proxy.url}/api/control/openapi.json`);
        // The browser is the one the check before signed in with: nothing of that is left.
        yield* until(
          "the page being there to sign out from",
          page.evaluate(
            `(localStorage.clear(), Promise.all([fetch("/api/auth/sign-out", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), fetch("/api/control/route/cookie", { method: "DELETE" })]).then(() => true))`,
            Schema.Boolean,
          ),
        );
        yield* page.evaluate(`void (location.href = "/")`);
        yield* signInWithToken(page, auditor.token);

        yield* page.until(`!!document.querySelector('a[href="/-/audit"]')`);
        expect(yield* page.text(`a[href="/-/audit"]`)).toBe("Audit");
        yield* page.click(`a[href="/-/audit"]`);
        yield* page.until(`document.title === "Aperture | Audit"`);
        const rows = `[...document.querySelectorAll("[data-console-event]")]`;
        const count = page.evaluate(`${rows}.length`, Schema.Number);
        // The newest first, a page of them, and the ones before when they are asked for.
        yield* page.until(`${rows}.length === 50`);
        expect(
          yield* page.evaluate(`${rows}[0].getAttribute("data-console-event")`, Schema.String),
        ).toBe("workspace.deleted");
        expect(yield* page.text(`[data-console-event] [data-console-event-says]`)).toBe(
          "Deleted the workspace",
        );
        yield* shot(page, fs, "console-audit");
        yield* page.evaluate(
          `void document.querySelector("[data-console-events-more]").scrollIntoView({ block: "nearest" })`,
        );
        yield* page.click("[data-console-events-more]");
        yield* page.until(`${rows}.length > 50`);
        expect(yield* count).toBeGreaterThan(54);

        // What an event is about leads to it while it is there, and only names it once it is gone.
        const about = (name: string) =>
          page.evaluate(
            `${rows}.filter((row) => row.textContent.includes(${JSON.stringify(name)})).map((row) => row.querySelector("[data-console-event-link]")?.getAttribute("href") ?? null)`,
            Schema.Array(Schema.NullOr(Schema.String)),
          );
        expect(yield* about("Kept workspace")).toEqual(["/-/workspaces"]);
        expect(yield* about("Gone workspace")).toEqual([null, null]);

        // By its kind, chosen from a list of all there are.
        yield* pick(page, `[aria-label="Kind of event"]`, "Workspace deleted");
        yield* page.until(
          `${rows}.length === 1 && ${rows}[0].getAttribute("data-console-event") === "workspace.deleted"`,
        );
        yield* page.click(`[aria-label="Kind of event"]`);
        yield* page.until(`!!document.querySelector('[data-slot="select-item"]')`);
        yield* rested(page);
        yield* shot(page, fs, "console-audit-kinds");
        yield* pick(page, `[aria-label="Kind of event"]`, "All events");
        yield* page.until(`${rows}.length >= 50`);

        // By who did it, by a part of what they are called.
        yield* page.click("[data-console-events-actor]");
        yield* page.type("quil");
        yield* page.until(
          `${rows}.length === 1 && ${rows}[0].textContent.includes("Quill") && ${rows}[0].textContent.includes("Made the workspace")`,
        );
        yield* shot(page, fs, "console-audit-actor");
        yield* page.click("[data-console-events-actor]");
        yield* page.type("-nobody-is-called-this");
        // Nothing matches, which is not that there is nothing: what narrowed the list is
        // taken back from there, and the list is whole again.
        yield* page.until(`!!document.querySelector('[data-console-empty="no-match"]')`);
        yield* shot(page, fs, "console-audit-no-match");
        yield* page.click("[data-console-clear-filters]");
        yield* page.until(
          `${rows}.length >= 50 && document.querySelector("[data-console-events-actor]").value === "" && location.search === ""`,
        );

        // On a phone an event is a block of its own, and what narrows the list is two
        // buttons in the title bar: the search opens below it, the kinds in a menu.
        const phone = yield* viewer.open(`${proxy.url}/-/audit`, {
          width: 390,
          height: 844,
          mobile: true,
        });
        yield* phone.until(`${rows}.length === 50`);
        yield* shot(phone, fs, "console-phone-audit");
        const scheme = (value: string) =>
          phone.cdp.call("Emulation.setEmulatedMedia", {
            features: [{ name: "prefers-color-scheme", value }],
          });
        yield* scheme("dark");
        yield* scheme("");
        expect(
          yield* phone.evaluate(
            `(() => {
              const table = document.querySelector('[data-slot="table-container"] [data-slot="scroll-area-viewport"]');
              const title = document.querySelector("[data-app-titlebar]");
              return {
                page: document.documentElement.scrollWidth <= innerWidth,
                table: table.scrollWidth <= table.clientWidth,
                cells: [...document.querySelectorAll('[data-slot="table-cell"]')].every((cell) => cell.getBoundingClientRect().right <= innerWidth),
                bar: [...title.querySelectorAll("button")].every((button) => { const box = button.getBoundingClientRect(); return box.width === 0 || (box.left >= 0 && box.right <= innerWidth); }),
              };
            })()`,
          ),
        ).toEqual({ page: true, table: true, cells: true, bar: true });
        yield* phone.click("[data-console-filters]");
        yield* phone.until(`!!document.querySelector('[data-slot="dropdown-menu-radio-item"]')`);
        yield* rested(phone);
        yield* shot(phone, fs, "console-phone-audit-kinds");
        yield* choose(phone, `[data-slot="dropdown-menu-radio-item"]`, "Workspace deleted");
        yield* phone.until(
          `${rows}.length === 1 && ${rows}[0].getAttribute("data-console-event") === "workspace.deleted"`,
        );
        yield* phone.click("[data-console-search-open]");
        yield* phone.until(
          `document.activeElement?.getAttribute("aria-label") === "Search by actor"`,
        );
        yield* phone.type("-nobody-is-called-this");
        yield* phone.until(`!!document.querySelector("[data-console-empty]")`);
        yield* shot(phone, fs, "console-phone-audit-search");
        expect(phone.errors()).toEqual([]);
        yield* phone.close;

        // The page's address says what it is narrowed by.
        const wide = yield* viewer.open(`${proxy.url}/-/audit?kind=workspace.deleted`, {
          width: 1440,
          height: 900,
        });
        yield* wide.until(`${rows}.length === 1`);
        yield* wide.evaluate(`void (location.href = "/-/audit")`);
        yield* wide.until(`${rows}.length === 50`);
        yield* shot(wide, fs, "console-audit-wide");
        yield* wide.close;
      }),
  );
});
