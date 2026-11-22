import { request } from "@aperture-browser/e2e/src/http.ts";
import { suite } from "@aperture-browser/e2e/src/suite.ts";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Control from "./src/control.ts";
import * as Dex from "./src/dex.ts";
import { askedThrough, signInThrough } from "./src/sso.ts";

const [ADDED, ANOTHER] = Dex.ADDED;
const PROVIDERS = "/api/control/sign-in-providers";
const OFFERED = "/api/control/sign-in/providers";
const WRONG_SECRET = "a-secret-the-provider-never-gave";

const Told = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  secretSet: Schema.Boolean,
  enabled: Schema.Boolean,
  source: Schema.String,
});
const Listed = Schema.Struct({ callbackBase: Schema.String, providers: Schema.Array(Told) });
const Refused = Schema.Struct({ _tag: Schema.String, problems: Schema.Array(Schema.String) });
const Checked = Schema.Struct({ ok: Schema.Boolean, problems: Schema.Array(Schema.String) });

const needs = (options: Control.ControlOptions) =>
  Dex.layer.pipe(Layer.provideMerge(Control.layer(options)), Layer.provideMerge(Dex.address));

/** Whether a browser's cookies sign anyone in. */
const signedIn = Effect.fn(function* (cookie: string) {
  const control = yield* Control.Control;
  const http = yield* HttpClient.HttpClient;
  const answer = yield* http.execute(
    HttpClientRequest.get(`${control.url}/api/control/account`).pipe(
      HttpClientRequest.setHeader("cookie", cookie),
    ),
  );
  return answer.status === 200;
});

/** What an admin asks of the providers, with whatever is answered. */
const asAdmin = (method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown) =>
  Effect.flatMap(Control.Control, (control) =>
    control.request(control.bootstrapToken, method, path, body),
  );

/** The suite's provider as an admin says it, known by `id`. */
const given = Effect.fn(function* (id: string, more: object = {}) {
  const at = yield* Dex.Address;
  return {
    id,
    name: "Added",
    issuer: at.issuer,
    clientId: at.clientId,
    clientSecret: at.clientSecret,
    ...more,
  };
});

const offered = Effect.fn(function* () {
  const control = yield* Control.Control;
  return (yield* request(control.url, "", "GET", OFFERED)).body;
});

/** What an admin is told a person signs in through. */
const through = Effect.fn(function* (email: string) {
  const control = yield* Control.Control;
  const bootstrap = yield* control.as(control.bootstrapToken);
  const account = (yield* bootstrap.accounts.list()).find((one) => one.email === email);
  return account?.signIn?.providers;
});

for (const stores of Control.STORES) {
  suite(needs({ stores, sso: { unnamed: true } }))(
    `providers an admin adds while the control plane runs, kept in ${stores}`,
    (it) => {
      it.effect("one that is added signs people in at once, and its secret is told to nobody", () =>
        Effect.gen(function* () {
          const control = yield* Control.Control;
          const at = yield* Dex.Address;
          expect(yield* offered()).toEqual([]);
          expect(yield* askedThrough(control.url, ADDED)).toBeGreaterThanOrEqual(400);

          const made = yield* asAdmin(
            "POST",
            PROVIDERS,
            yield* given(ADDED, { provision: true, domains: ["example.test"] }),
          );
          expect(made.status).toBe(201);
          expect(made.body).toMatchObject({
            id: ADDED,
            issuer: at.issuer,
            secretSet: true,
            scopes: ["openid", "email", "profile"],
            provision: true,
            domains: ["example.test"],
            enabled: true,
            source: "stored",
          });
          expect(JSON.stringify(made.body)).not.toContain(at.clientSecret);
          const listed = yield* Schema.decodeUnknownEffect(Listed)(
            (yield* asAdmin("GET", PROVIDERS)).body,
          );
          expect(listed.callbackBase).toBe(`${control.url}/api/auth/callback/`);
          expect(listed.providers.map((one) => one.id)).toEqual([ADDED]);
          expect(yield* offered()).toEqual([{ id: ADDED, name: "Added" }]);

          // Nobody made Bob a person: the provider does, as it was told to.
          const [, bob, carol] = Dex.VERIFIED;
          const landed = yield* signInThrough(control.url, "local", bob.email, undefined, ADDED);
          expect(landed.at).toBe("/-/sessions");
          expect(yield* signedIn(landed.cookie)).toBe(true);
          expect(yield* through(bob.email)).toEqual(["Added"]);
          // And of its own domains alone.
          const other = yield* signInThrough(control.url, "local", carol.email, undefined, ADDED);
          expect(other.at).toMatch(/^\/sign-in-refused\?error=email_domain_refused/u);

          // A second one by that id is refused, whatever it says of itself.
          const again = yield* asAdmin("POST", PROVIDERS, yield* given(ADDED, { enabled: false }));
          expect(again).toMatchObject({ status: 409, body: { _tag: "ProviderTaken" } });
        }),
      );

      it.effect("one that is changed keeps its secret unless another is given", () =>
        Effect.gen(function* () {
          const control = yield* Control.Control;
          const at = yield* Dex.Address;
          const [, bob] = Dex.VERIFIED;
          const before = yield* signInThrough(control.url, "local", bob.email, undefined, ADDED);

          const renamed = yield* asAdmin("PATCH", `${PROVIDERS}/${ADDED}`, {
            name: "Renamed",
            clientSecret: "",
          });
          expect(renamed).toMatchObject({
            status: 200,
            body: { name: "Renamed", secretSet: true },
          });
          expect(JSON.stringify(renamed.body)).not.toContain(at.clientSecret);
          expect(yield* offered()).toEqual([{ id: ADDED, name: "Renamed" }]);
          const landed = yield* signInThrough(control.url, "local", bob.email, undefined, ADDED);
          expect(landed.at).toBe("/-/sessions");
          // Whoever was signed in before the change still is.
          expect(yield* signedIn(before.cookie)).toBe(true);

          // Another secret is the one that is used from then on.
          yield* asAdmin("PATCH", `${PROVIDERS}/${ADDED}`, { clientSecret: WRONG_SECRET });
          const refused = yield* signInThrough(control.url, "local", bob.email, undefined, ADDED);
          expect(refused.at).toMatch(/^\/sign-in-refused\?error=/u);
          yield* asAdmin("PATCH", `${PROVIDERS}/${ADDED}`, { clientSecret: at.clientSecret });
          const back = yield* signInThrough(control.url, "local", bob.email, undefined, ADDED);
          expect(back.at).toBe("/-/sessions");
        }),
      );

      it.effect(
        "one that is disabled signs nobody in and is not offered, until it is enabled",
        () =>
          Effect.gen(function* () {
            const control = yield* Control.Control;
            const [, bob] = Dex.VERIFIED;
            const before = yield* signInThrough(control.url, "local", bob.email, undefined, ADDED);
            const disabled = yield* asAdmin("PATCH", `${PROVIDERS}/${ADDED}`, { enabled: false });
            expect(disabled).toMatchObject({ status: 200, body: { enabled: false } });
            expect(yield* offered()).toEqual([]);
            expect(yield* askedThrough(control.url, ADDED)).toBeGreaterThanOrEqual(400);
            // Who came through it is there, signed in where they were, and told to have come so.
            expect(yield* signedIn(before.cookie)).toBe(true);
            expect(yield* through(bob.email)).toEqual(["Renamed (disabled)"]);

            yield* asAdmin("PATCH", `${PROVIDERS}/${ADDED}`, { enabled: true });
            expect(yield* offered()).toEqual([{ id: ADDED, name: "Renamed" }]);
            const landed = yield* signInThrough(control.url, "local", bob.email, undefined, ADDED);
            expect(landed.at).toBe("/-/sessions");
          }),
      );

      it.effect("one that does not say how it is reached is refused, unless kept disabled", () =>
        Effect.gen(function* () {
          const control = yield* Control.Control;
          const at = yield* Dex.Address;
          // The control plane itself is no provider: nothing is where its document would be.
          const nowhere = yield* given(ANOTHER, { issuer: `${control.url}/nowhere` });
          const refused = yield* asAdmin("POST", PROVIDERS, nowhere);
          expect(refused.status).toBe(400);
          const why = yield* Schema.decodeUnknownEffect(Refused)(refused.body);
          expect(why._tag).toBe("ProviderInvalid");
          expect(why.problems).toHaveLength(1);
          expect(why.problems[0]).toContain("/nowhere/.well-known/openid-configuration");
          expect(yield* asAdmin("GET", PROVIDERS)).not.toMatchObject({
            body: { providers: [{}, {}] },
          });

          // Without TLS, it is asked nowhere but on this machine.
          const plain = yield* asAdmin(
            "POST",
            PROVIDERS,
            yield* given(ANOTHER, { issuer: "http://provider.example", enabled: false }),
          );
          expect(plain.status).toBe(400);
          expect((yield* Schema.decodeUnknownEffect(Refused)(plain.body)).problems[0]).toContain(
            "https://",
          );

          const check = (issuer: string) =>
            asAdmin("POST", `${PROVIDERS}/check`, { issuer }).pipe(
              Effect.flatMap((answer) => Schema.decodeUnknownEffect(Checked)(answer.body)),
            );
          expect(yield* check(at.issuer)).toEqual({ ok: true, problems: [] });
          expect(yield* check(`${at.issuer}/.well-known/openid-configuration`)).toEqual({
            ok: true,
            problems: [],
          });
          expect((yield* check(`${control.url}/nowhere`)).ok).toBe(false);
          // A document of another issuer than was asked for is nobody's word.
          const elsewhere = yield* check(`http://localhost:${at.port}/dex`);
          expect(elsewhere.ok).toBe(false);
          expect(elsewhere.problems[0]).toContain(at.issuer);
          expect((yield* check("not an address")).ok).toBe(false);

          // Kept disabled, it is there and signs nobody in; enabling it asks it again.
          const kept = yield* asAdmin("POST", PROVIDERS, { ...nowhere, enabled: false });
          expect(kept).toMatchObject({ status: 201, body: { id: ANOTHER, enabled: false } });
          const enabled = yield* asAdmin("PATCH", `${PROVIDERS}/${ANOTHER}`, { enabled: true });
          expect(enabled).toMatchObject({ status: 400, body: { _tag: "ProviderInvalid" } });
          expect(yield* offered()).toEqual([{ id: ADDED, name: "Renamed" }]);
          expect((yield* asAdmin("DELETE", `${PROVIDERS}/${ANOTHER}`)).status).toBe(204);
        }),
      );

      it.effect("removing one removes nobody, and whoever came through it comes again", () =>
        Effect.gen(function* () {
          const control = yield* Control.Control;
          const bootstrap = yield* control.as(control.bootstrapToken);
          const [, bob] = Dex.VERIFIED;
          const before = (yield* bootstrap.accounts.list()).find((one) => one.email === bob.email);
          expect((yield* asAdmin("DELETE", `${PROVIDERS}/${ADDED}`)).status).toBe(204);
          expect((yield* asAdmin("DELETE", `${PROVIDERS}/${ADDED}`)).status).toBe(404);
          expect(yield* offered()).toEqual([]);
          expect(yield* askedThrough(control.url, ADDED)).toBeGreaterThanOrEqual(400);
          expect(yield* through(bob.email)).toEqual([`${ADDED} (removed)`]);

          // Back by the same id, it finds them as who they were. It makes nobody now.
          expect((yield* asAdmin("POST", PROVIDERS, yield* given(ADDED))).status).toBe(201);
          const landed = yield* signInThrough(control.url, "local", bob.email, undefined, ADDED);
          expect(landed.at).toBe("/-/sessions");
          const after = (yield* bootstrap.accounts.list()).find((one) => one.email === bob.email);
          expect(after?.id).toBe(before?.id);
          const [ada] = Dex.VERIFIED;
          const nobody = yield* signInThrough(control.url, "local", ada.email, undefined, ADDED);
          expect(nobody.at).toBe("/sign-in-refused?error=signup_disabled");
        }),
      );

      it.effect("what another program on the database changed is so here as well", () =>
        Effect.gen(function* () {
          const control = yield* Control.Control;
          if (Option.isNone(control.sql)) {
            return;
          }
          const sql = control.sql.value;
          // As another control plane writes it: the provider and the count together.
          yield* sql`
            WITH counted AS (UPDATE providers_revision SET revision = revision + 1 RETURNING 1)
            UPDATE providers SET enabled = false WHERE id = ${ADDED}
          `;
          expect(yield* offered()).toEqual([]);
          expect(yield* askedThrough(control.url, ADDED)).toBeGreaterThanOrEqual(400);
          yield* sql`
            WITH counted AS (UPDATE providers_revision SET revision = revision + 1 RETURNING 1)
            UPDATE providers SET enabled = true WHERE id = ${ADDED}
          `;
          const [, bob] = Dex.VERIFIED;
          const landed = yield* signInThrough(control.url, "local", bob.email, undefined, ADDED);
          expect(landed.at).toBe("/-/sessions");
        }),
      );

      it.effect("all of it is in the event log, and the secret in none of it", () =>
        Effect.gen(function* () {
          const control = yield* Control.Control;
          const at = yield* Dex.Address;
          const events = yield* asAdmin(
            "GET",
            "/api/control/events?resourceKind=provider&limit=100",
          );
          const text = JSON.stringify(events.body);
          for (const kind of ["added", "changed", "disabled", "enabled", "removed"]) {
            expect(text).toContain(`"provider.${kind}"`);
          }
          expect(text).toContain('"changed":["clientSecret"]');
          const all = JSON.stringify([
            (yield* asAdmin("GET", "/api/control/events?limit=200")).body,
            (yield* asAdmin("GET", PROVIDERS)).body,
            yield* offered(),
          ]);
          expect(all).not.toContain(at.clientSecret);
          expect(all).not.toContain(WRONG_SECRET);
          if (Option.isSome(control.sql)) {
            const kept = JSON.stringify(yield* control.sql.value`SELECT * FROM providers`);
            expect(kept).not.toContain(at.clientSecret);
          }
        }),
      );

      it.effect("the providers are an admin's alone", () =>
        Effect.gen(function* () {
          const control = yield* Control.Control;
          const { token } = yield* Control.account("Grace");
          expect((yield* control.request(token, "GET", PROVIDERS)).status).toBe(403);
          expect(
            (yield* control.request(token, "POST", PROVIDERS, yield* given(ANOTHER))).status,
          ).toBe(403);
          expect(
            (yield* control.request(token, "PATCH", `${PROVIDERS}/${ADDED}`, { enabled: false }))
              .status,
          ).toBe(403);
          expect((yield* control.request(token, "DELETE", `${PROVIDERS}/${ADDED}`)).status).toBe(
            403,
          );
          expect(
            (yield* control.request(token, "POST", `${PROVIDERS}/check`, { issuer: "https://a.b" }))
              .status,
          ).toBe(403);
          expect((yield* control.request("", "GET", PROVIDERS)).status).toBe(401);
        }),
      );
    },
  );

  suite(needs({ stores, sso: { provision: true, domains: ["example.test"] } }))(
    `a provider the settings name, beside those an admin adds, kept in ${stores}`,
    (it) => {
      it.effect("it is told with what the settings say of all of them, and changed nowhere", () =>
        Effect.gen(function* () {
          const at = yield* Dex.Address;
          const listed = yield* asAdmin("GET", PROVIDERS);
          expect(listed.body).toMatchObject({
            providers: [
              {
                id: Dex.PROVIDER,
                name: Dex.PROVIDER_NAME,
                issuer: at.issuer,
                secretSet: true,
                provision: true,
                domains: ["example.test"],
                enabled: true,
                source: "configuration",
                createdAt: null,
              },
            ],
          });
          expect(JSON.stringify(listed.body)).not.toContain(at.clientSecret);
          const changed = yield* asAdmin("PATCH", `${PROVIDERS}/${Dex.PROVIDER}`, {
            enabled: false,
          });
          expect(changed).toMatchObject({ status: 409, body: { _tag: "ProviderConfigured" } });
          const removed = yield* asAdmin("DELETE", `${PROVIDERS}/${Dex.PROVIDER}`);
          expect(removed).toMatchObject({ status: 409, body: { _tag: "ProviderConfigured" } });
          const taken = yield* asAdmin("POST", PROVIDERS, yield* given(Dex.PROVIDER));
          expect(taken).toMatchObject({ status: 409, body: { _tag: "ProviderTaken" } });
          expect(yield* offered()).toEqual([{ id: Dex.PROVIDER, name: Dex.PROVIDER_NAME }]);
        }),
      );

      it.effect("one an admin adds beside it says for itself whom it makes a person", () =>
        Effect.gen(function* () {
          const control = yield* Control.Control;
          const [, bob] = Dex.VERIFIED;
          expect((yield* asAdmin("POST", PROVIDERS, yield* given(ADDED))).status).toBe(201);
          expect(yield* offered()).toEqual([
            { id: Dex.PROVIDER, name: Dex.PROVIDER_NAME },
            { id: ADDED, name: "Added" },
          ]);
          const refused = yield* signInThrough(control.url, "local", bob.email, undefined, ADDED);
          expect(refused.at).toBe("/sign-in-refused?error=signup_disabled");
          const landed = yield* signInThrough(control.url, "local", bob.email);
          expect(landed.at).toBe("/-/sessions");
        }),
      );
    },
  );
}
