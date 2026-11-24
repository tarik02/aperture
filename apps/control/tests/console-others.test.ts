import { request } from "@aperture-browser/e2e/src/http.ts";
import * as Mcp from "@aperture-browser/e2e/src/mcp.ts";
import { suite } from "@aperture-browser/e2e/src/suite.ts";
import * as Viewer from "@aperture-browser/e2e/src/viewer.ts";
import { until } from "@aperture-browser/e2e/src/wait.ts";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schema from "effect/Schema";
import * as Control from "./src/control.ts";
import * as Dex from "./src/dex.ts";
import { signedIn } from "./src/person.ts";
import * as Proxy from "./src/proxy.ts";
import {
  DIALOG,
  ENTER,
  ESCAPE,
  choose,
  fromMenu,
  needs,
  pick,
  pressUntil,
  rested,
  shot,
} from "./src/console.ts";

suite(needs)("apps, providers and guests at the console, behind the proxy", (it) => {
  it.effect("an app sends a person to say what it gets, who signs in first and is sent back", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const proxy = yield* Proxy.Proxy;
      const viewer = yield* Viewer.Viewer;
      const fs = yield* FileSystem.FileSystem;
      const sana = yield* signedIn("Sana", "sana@example.test");
      const bootstrap = yield* control.as(control.bootstrapToken);
      const own = yield* bootstrap.accounts.createToken({
        params: { id: sana.account.id },
        payload: { name: "checks", scopes: ["workspaces:write", "tokens:write"] },
      });
      const asSana = yield* control.as(own.token);
      const crawlers = yield* asSana.workspaces.create({ payload: { name: "Crawlers of Sana" } });
      const reports = yield* asSana.workspaces.create({ payload: { name: "Reports of Sana" } });
      const registered = yield* request(proxy.url, "", "POST", "/oauth/register", {
        client_name: "An agent of the checks",
        redirect_uris: [`${proxy.url}/callback`],
      });
      const app = yield* Schema.decodeUnknownEffect(Schema.Struct({ client_id: Schema.String }))(
        registered.body,
      );
      const verifier = "what-the-app-keeps-to-itself-0123456789-0123456789";
      const challenge = Base64Url.encode(
        new Uint8Array(
          yield* Effect.promise(() =>
            crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
          ),
        ),
      );
      const asked = new URLSearchParams({
        response_type: "code",
        client_id: app.client_id,
        redirect_uri: `${proxy.url}/callback`,
        state: "the app's own",
        scope: "sessions:read",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });

      const page = yield* viewer.open(`${proxy.url}/oauth/authorize?${asked.toString()}`);
      yield* page.until(`location.pathname === "/oauth/consent"`);
      // The browser is the one the checks before signed in with: nothing of that is left.
      yield* page.evaluate(
        `(localStorage.clear(), fetch("/api/auth/sign-out", { method: "POST" }).then((answer) => answer.status))`,
      );
      yield* page.evaluate("void location.reload()");
      yield* page.until(`!!document.querySelector('[data-console-sign-in="password"]')`);
      yield* page.click(`[data-console-sign-in] input[name="email"]`);
      yield* page.type(sana.email);
      yield* page.click(`[data-console-sign-in] input[name="password"]`);
      yield* page.type(sana.password);
      yield* page.key("Enter", "Enter", ENTER);

      // Signed in, they are where the app sent them, and are asked what the app asked for.
      yield* page.until(`!!document.querySelector("[data-console-consent-allow]")`);
      expect(yield* page.text("[data-console-consent]")).toContain(
        "Connect An agent of the checks?",
      );
      const ticked = page.evaluate(
        `[...document.querySelectorAll("[data-console-consent] [data-console-scope][data-checked]")].map((one) => one.dataset.consoleScope)`,
      );
      expect(yield* ticked).toEqual(["sessions:read"]);
      // What may be given is told by what it is of; what only an admin does is not offered
      // to someone who is none.
      expect(
        yield* page.evaluate(
          `[...document.querySelectorAll("[data-console-scope-group]")].map((one) => one.dataset.consoleScopeGroup)`,
        ),
      ).toEqual(["Sessions and snapshots", "Workspaces and account"]);
      yield* rested(page);
      yield* shot(page, fs, "console-consent");

      // Writing something reads it: ticked, it ticks the reading, and with the reading
      // unticked it is unticked as well.
      const tick = (scope: string, then: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          yield* page.click(`[data-console-scope="${scope}"]`);
          yield* until(
            `${then.join(", ")} being ticked`,
            Effect.map(ticked, (now) => JSON.stringify(now) === JSON.stringify(then)),
          );
        });
      yield* tick("sessions:write", ["sessions:read", "sessions:write"]);
      yield* tick("sessions:read", []);
      yield* tick("workspaces:write", ["workspaces:read", "workspaces:write"]);
      yield* tick("workspaces:read", []);
      yield* tick("sessions:read", ["sessions:read"]);
      yield* tick("snapshots:write", ["sessions:read", "snapshots:read", "snapshots:write"]);

      // What it reaches is chosen in one field: pressed, it opens a list with what is typed
      // at its top, and nothing of the page moves for it.
      const reach = "[data-console-consent-reach] [data-console-token-resources]";
      const search = `document.querySelector("[data-console-token-resources-search]")`;
      const chosen = (id: string) => `[data-console-token-resource-chosen="workspaces:${id}"]`;
      expect(yield* page.text(reach)).toBe("Everything this account reaches");
      expect(yield* page.evaluate(`!!document.querySelector('${reach} input')`)).toBe(false);
      const allow = yield* page.box("[data-console-consent-allow]");
      yield* page.click(reach);
      yield* page.until(`document.activeElement === ${search}`);
      yield* page.type("of sana");
      for (const workspace of [crawlers, reports]) {
        yield* page.click(`[data-console-token-resource="workspaces:${workspace.id}"]`);
        yield* page.until(`!!document.querySelector('${chosen(workspace.id)}')`);
      }
      yield* rested(page);
      yield* shot(page, fs, "console-consent-resources");
      // Escape closes the list and nothing else, and the field has the focus again; a key
      // opens it from there.
      yield* page.key("Escape", "Escape", ESCAPE);
      yield* page.until(
        `!${search} && document.activeElement === document.querySelector('${reach}')`,
      );
      yield* page.key("Enter", "Enter", ENTER);
      yield* page.until(`document.activeElement === ${search}`);
      yield* page.key("Escape", "Escape", ESCAPE);
      yield* page.until(`!${search}`);
      // What was chosen is given up where it is shown.
      yield* page.click(`${chosen(reports.id)} [data-slot="picker-chip-remove"]`);
      yield* page.until(`!document.querySelector('${chosen(reports.id)}')`);
      expect(yield* page.text(reach)).toBe("Workspace: Crawlers of Sana");
      yield* rested(page);
      expect(yield* page.box("[data-console-consent-allow]")).toEqual(allow);
      const scheme = (of: Viewer.Page, value: string) =>
        of.cdp.call("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value }],
        });
      yield* scheme(page, "dark");
      yield* shot(page, fs, "console-consent-dark");
      yield* scheme(page, "");

      // On a phone a thing is named above what is ticked for it, and the page is no wider
      // than the screen, with the list open as well.
      const phone = yield* viewer.open(`${proxy.url}/oauth/authorize?${asked.toString()}`, {
        width: 390,
        height: 844,
        mobile: true,
      });
      yield* phone.until(`!!document.querySelector("[data-console-consent-allow]")`);
      yield* phone.tap(`[data-console-scope="sessions:write"]`);
      yield* phone.until(
        `document.querySelectorAll('[data-console-scope^="sessions:"][data-checked]').length === 2`,
      );
      yield* rested(phone);
      yield* shot(phone, fs, "console-phone-consent");
      yield* scheme(phone, "dark");
      yield* shot(phone, fs, "console-phone-consent-dark");
      yield* scheme(phone, "");
      yield* phone.tap(reach);
      yield* phone.until(
        `!!document.querySelector('[data-console-token-resource="workspaces:${crawlers.id}"]')`,
      );
      yield* rested(phone);
      yield* shot(phone, fs, "console-phone-consent-resources");
      expect(yield* phone.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(
        true,
      );
      expect(phone.errors()).toEqual([]);
      yield* phone.close;

      expect(page.errors()).toEqual([]);
      yield* page.click("[data-console-consent-allow]");
      yield* page.until(`location.pathname === "/callback"`);
      const back = new URLSearchParams(yield* page.evaluate("location.search", Schema.String));
      expect(back.get("state")).toBe("the app's own");

      const http = yield* HttpClient.HttpClient;
      const tokens = yield* http
        .execute(
          HttpClientRequest.post(`${proxy.url}/oauth/token`).pipe(
            HttpClientRequest.bodyUrlParams({
              grant_type: "authorization_code",
              code: back.get("code") ?? "",
              client_id: app.client_id,
              redirect_uri: `${proxy.url}/callback`,
              code_verifier: verifier,
            }),
          ),
        )
        .pipe(
          Effect.flatMap((answer) => answer.json),
          Effect.flatMap(
            Schema.decodeUnknownEffect(Schema.Struct({ access_token: Schema.String })),
          ),
        );
      // The grant holds what was ticked, the reading with the writing, and reaches what was
      // left chosen.
      expect((yield* asSana.grants.list()).map((grant) => [grant.scopes, grant.resources])).toEqual(
        [
          [
            ["sessions:read", "snapshots:read", "snapshots:write"],
            { workspaces: [crawlers.id], sessions: [], snapshots: [] },
          ],
        ],
      );
      const agent = yield* Mcp.connect(proxy.url, tokens.access_token);
      yield* agent.call("sessions.list", {});
      expect((yield* Effect.flip(agent.call("sessions.create", {}))).reason).toMatch(
        /not for sessions:write/u,
      );

      // What they gave is theirs to see, and to take back.
      yield* page.evaluate(`void (location.href = "/-/account/connections")`);
      yield* page.until(
        `!!document.querySelector('[data-console-grant="An agent of the checks"] [data-console-grant-scope="sessions:read"]')`,
      );
      yield* shot(page, fs, "console-connected-apps");
      yield* page.click(`[data-console-grant] button`);
      yield* choose(page, `[data-slot="dialog-footer"] button`, "Disconnect");
      yield* page.until(`!document.querySelector("[data-console-grant]")`);
      expect((yield* request(proxy.url, tokens.access_token, "POST", "/mcp", {})).status).toBe(401);
    }),
  );

  it.effect(
    "a person signs in through a provider from the sign-in page, and one it is none for is told",
    () =>
      Effect.gen(function* () {
        const control = yield* Control.Control;
        const proxy = yield* Proxy.Proxy;
        const viewer = yield* Viewer.Viewer;
        const fs = yield* FileSystem.FileSystem;
        const bootstrap = yield* control.as(control.bootstrapToken);
        const [ada, bob] = Dex.VERIFIED;
        yield* bootstrap.accounts.create({
          payload: { name: "Ada of the provider", email: ada.email },
        });

        const page = yield* viewer.open(`${proxy.url}/-/snapshots`);
        // The browser is the one the checks before signed in with: nothing of that is left.
        yield* page.evaluate(
          `(localStorage.clear(), Promise.all([fetch("/api/auth/sign-out", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), fetch("/api/control/route/cookie", { method: "DELETE" })]).then(() => true))`,
        );
        yield* page.evaluate("void location.reload()");

        /** Goes to the provider by the button, and signs in there with a password. */
        const through = (email: string) =>
          Effect.gen(function* () {
            yield* page.until(`!!document.querySelector('[data-console-sso="${Dex.PROVIDER}"]')`);
            expect(yield* page.text(`[data-console-sso="${Dex.PROVIDER}"]`)).toBe(
              `Continue with ${Dex.PROVIDER_NAME}`,
            );
            yield* page.click(`[data-console-sso="${Dex.PROVIDER}"]`);
            // The provider has more ways than one, and asks which.
            yield* page.until(`!!document.querySelector('a[href*="/dex/auth/local"]')`);
            // The provider's page is there before it takes a press, on a busy machine.
            yield* pressUntil(
              page,
              `a[href*="/dex/auth/local"]`,
              `document.querySelector('input[name="login"]')`,
            );
            yield* page.click(`input[name="login"]`);
            yield* page.type(email);
            yield* page.click(`input[name="password"]`);
            yield* page.type(Dex.PASSWORD);
            yield* page.key("Enter", "Enter", ENTER);
          });

        yield* through(bob.email);
        yield* page.until(`!!document.querySelector("[data-console-sso-refused]")`);
        expect(yield* page.text("[data-console-sso-refused]")).toMatch(/No account here/u);
        // They are where they were going, and why not is in the address no more.
        expect(yield* page.evaluate("location.pathname + location.search", Schema.String)).toBe(
          "/-/snapshots",
        );
        yield* shot(page, fs, "console-sign-in-provider");

        yield* through(ada.email);
        yield* page.until(
          `location.origin === ${JSON.stringify(proxy.url)} && !document.querySelector("[data-console-sign-in]") && !!document.querySelector("[data-sidebar]")`,
          "30 seconds",
        );
        expect(yield* page.evaluate("location.pathname", Schema.String)).toBe("/-/snapshots");
        expect(
          yield* page.evaluate(
            `fetch("/api/control/account").then((answer) => answer.json()).then((account) => account.email)`,
            Schema.String,
          ),
        ).toBe(ada.email);

        // Disabled, they are signed out where they are, and told why the provider's word
        // signs them in no more.
        const account = yield* bootstrap.accounts
          .list()
          .pipe(Effect.map((all) => all.find((one) => one.email === ada.email)));
        yield* bootstrap.accounts.disable({ params: { id: account?.id ?? "" } });
        yield* page.evaluate("void location.reload()");
        yield* through(ada.email);
        yield* page.until(`!!document.querySelector("[data-console-sso-refused]")`);
        expect(yield* page.text("[data-console-sso-refused]")).toBe(
          "This account is disabled. Ask an admin.",
        );
        yield* shot(page, fs, "console-sign-in-disabled");
        expect(page.errors()).toEqual([]);
      }),
  );

  it.effect(
    "the owner makes a share link, a guest with no account opens it under a name, and is out once it is revoked",
    () =>
      Effect.gen(function* () {
        const proxy = yield* Proxy.Proxy;
        const viewer = yield* Viewer.Viewer;
        const fs = yield* FileSystem.FileSystem;
        const control = yield* Control.Control;
        const bootstrap = yield* control.as(control.bootstrapToken);
        // A person, whom every page of the browser has signed in at once.
        const person = yield* signedIn("Owner of the shared", "owner-of-the-shared@example.test");
        const { token } = yield* bootstrap.accounts.createToken({
          params: { id: person.account.id },
          payload: { name: "checks", scopes: Control.ALL_SCOPES },
        });
        const owner = { api: yield* control.as(token) };
        // The node may only now have told of itself, where no check ran before this one.
        const made = yield* until(
          "a node taking the shared session",
          owner.api.sessions.create({ payload: { label: "Shared with a guest" } }),
          "30 seconds",
        );
        yield* until(
          "the shared session running",
          owner.api.sessions
            .get({ params: { id: made.id } })
            .pipe(Effect.map((session) => session.observedState === "running")),
          "60 seconds",
        );

        const page = yield* viewer.open(`${proxy.url}/-/sessions`);
        // The browser is the one the checks before signed in with: nothing of that is left.
        yield* page.evaluate(
          `(localStorage.clear(), Promise.all([fetch("/api/auth/sign-out", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), fetch("/api/control/route/cookie", { method: "DELETE" })]).then(() => true))`,
        );
        yield* page.evaluate("void location.reload()");
        yield* page.until(`!!document.querySelector('[data-console-sign-in="password"]')`);
        yield* page.click(`[data-console-sign-in] input[name="email"]`);
        yield* page.type(person.email);
        yield* page.click(`[data-console-sign-in] input[name="password"]`);
        yield* page.type(person.password);
        yield* page.key("Enter", "Enter", ENTER);
        const card = `[data-console-session="${made.id}"]`;
        yield* page.until(`!!document.querySelector(${JSON.stringify(card)})`);
        yield* fromMenu(page, card, "Share");

        const name = `[data-console-share-create] input[name="name"]`;
        yield* page.until(
          `document.querySelector(${JSON.stringify(name)})?.closest('[data-slot="dialog-content"]').getAnimations().length === 0`,
        );
        const height = () =>
          page.evaluate(
            `document.querySelector(${JSON.stringify(name)}).closest('[data-slot="dialog-content"]').getBoundingClientRect().height`,
            Schema.Number,
          );
        const empty = yield* height();
        yield* page.click(name);
        yield* page.type("For the guest");
        yield* pick(
          page,
          `[data-console-share-create] [aria-label="What it lets them do"]`,
          "Control",
        );
        yield* choose(page, "[data-console-share-create] button", "New link");
        yield* page.until(`!!document.querySelector("[data-console-secret]")`);
        const link = (yield* page.text("[data-console-secret]")) ?? "";
        expect(link).toMatch(new RegExp(`^${proxy.url}/share/[0-9a-f-]+#aps_`, "u"));
        yield* shot(page, fs, "console-share-link");
        yield* choose(page, `${DIALOG} button`, "Done");
        yield* page.until(`!document.querySelector("[data-console-secret]")`);
        yield* page.until(`!!document.querySelector('[data-console-share="For the guest"]')`);
        expect(yield* page.text(`[data-console-share="For the guest"]`)).toContain("Control");
        // The dialog is as tall with a link in it as it was with none.
        expect(yield* height()).toBe(empty);
        yield* shot(page, fs, "console-share");

        // A browser of the guest's own: it carries nothing of the owner's.
        const guests = yield* Viewer.start;
        const guest = yield* guests.open(link);
        yield* guest.until(`!!document.querySelector('[data-console-guest="name"] input')`);
        // The secret is in the address no more, and nothing of the console is around.
        expect(yield* guest.evaluate("location.pathname + location.hash", Schema.String)).toBe(
          new URL(link).pathname,
        );
        expect(yield* guest.evaluate(`!!document.querySelector("[data-sidebar]")`)).toBe(false);
        yield* shot(guest, fs, "console-guest-name");
        yield* guest.click(`[data-console-guest="name"] input`);
        yield* guest.type("Grace the guest");
        yield* guest.key("Enter", "Enter", ENTER);
        yield* guest.until(`!!document.querySelector('[data-console-guest="session"]')`);
        yield* Viewer.ready(guest);
        yield* guest.until(`!!document.querySelector("[data-aperture-drawn]")`, "30 seconds");
        expect(yield* guest.evaluate(`!!document.querySelector("[data-sidebar]")`)).toBe(false);
        // Shown again, the page needs no link in its address: the browser carries it.
        yield* guest.evaluate("void location.reload()");
        yield* guest.until(`!!document.querySelector('[data-console-guest="session"]')`);
        yield* Viewer.ready(guest);
        yield* guest.until(`!!document.querySelector("[data-aperture-drawn]")`, "30 seconds");
        yield* shot(guest, fs, "console-guest-session");
        // The API is none of a guest's.
        expect(
          yield* guest.evaluate(
            `fetch("/api/control/sessions").then((answer) => answer.status)`,
            Schema.Number,
          ),
        ).toBe(401);

        // The owner sees them among the members, by the name they chose.
        const opened = yield* viewer.open(`${proxy.url}/-/sessions/${made.id}`);
        yield* Viewer.ready(opened, 2);
        const members = `apertureSession.getSnapshot().presence.members.map((member) => member.name)`;
        yield* opened.until(`${members}.includes("Grace the guest")`);
        expect(yield* opened.evaluate(members, Schema.Array(Schema.String))).toEqual(
          expect.arrayContaining(["Owner of the shared", "Grace the guest"]),
        );

        // Taking a link back is asked again, as whatever is not undone is.
        yield* page.click(`[data-console-share="For the guest"] button`);
        yield* choose(page, `[data-slot="dialog-footer"] button`, "Revoke");
        yield* page.until(`!document.querySelector('[data-console-share="For the guest"]')`);
        yield* guest.until(
          `!!document.querySelector('[data-console-guest="refused"]')`,
          "30 seconds",
        );
        yield* shot(guest, fs, "console-guest-refused");
        yield* opened.until(`!${members}.includes("Grace the guest")`);
        expect(page.errors()).toEqual([]);
        yield* owner.api.sessions.delete({ params: { id: made.id } });
      }),
  );
});
