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
import * as Hub from "./src/hub.ts";
import { askedThrough, signInThrough } from "./src/sso.ts";

const [ADDED, ANOTHER] = Dex.ADDED;
/** What the provider that speaks OAuth 2.0 alone is known by, and one it is made of anew. */
const HUB = "hub";
const HUB_OPEN = "hub-open";
const HUB_SCOPES = ["read:user", "user:email"];
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
const Checked = Schema.Struct({
  ok: Schema.Boolean,
  problems: Schema.Array(Schema.String),
  scopes: Schema.Array(Schema.String),
});

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
          // Reached, it is told with the scopes it says it gives.
          const reached = yield* check(at.issuer);
          expect(reached).toMatchObject({ ok: true, problems: [] });
          expect(reached.scopes).toEqual(expect.arrayContaining(["openid", "email", "groups"]));
          expect(yield* check(`${at.issuer}/.well-known/openid-configuration`)).toEqual(reached);
          expect(yield* check(`${control.url}/nowhere`)).toMatchObject({ ok: false, scopes: [] });
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

  suite(Hub.layer.pipe(Layer.provideMerge(needs({ stores, sso: { unnamed: true } }))))(
    `a provider that speaks OAuth 2.0 alone, as GitHub does, kept in ${stores}`,
    (it) => {
      /** The hub as an admin says it, known by `id`. */
      const hub = Effect.fn(function* (id: string, more: object = {}) {
        const at = yield* Hub.Hub;
        return {
          id,
          name: "Hub",
          kind: "oauth2",
          endpoints: at.endpoints,
          clientId: at.clientId,
          clientSecret: at.clientSecret,
          scopes: HUB_SCOPES,
          ...more,
        };
      });
      const person = Effect.fn(function* (name: string, email: string) {
        const control = yield* Control.Control;
        const bootstrap = yield* control.as(control.bootstrapToken);
        return yield* bootstrap.accounts.create({ payload: { name, email } });
      });

      it.effect("it signs in whom it says it verified the first address of, and nobody else", () =>
        Effect.gen(function* () {
          const control = yield* Control.Control;
          const at = yield* Hub.Hub;
          const made = yield* asAdmin("POST", PROVIDERS, yield* hub(HUB));
          expect(made.status).toBe(201);
          expect(made.body).toMatchObject({
            id: HUB,
            kind: "oauth2",
            issuer: "",
            endpoints: at.endpoints,
            scopes: HUB_SCOPES,
            secretSet: true,
            enabled: true,
            source: "stored",
          });
          expect(JSON.stringify(made.body)).not.toContain(at.clientSecret);
          expect(yield* offered()).toEqual([{ id: HUB, name: "Hub" }]);

          // Ada is a person here by the address the hub has first for her, and verified.
          yield* person("Ada", "ada@example.test");
          const landed = yield* Hub.signInThroughHub(control.url, HUB, "ada");
          expect(landed.at).toBe("/-/sessions");
          expect(yield* signedIn(landed.cookie)).toBe(true);
          expect(yield* through("ada@example.test")).toEqual(["Hub"]);
          // And again, as who the hub knows her by.
          expect((yield* Hub.signInThroughHub(control.url, HUB, "ada")).at).toBe("/-/sessions");

          // Eve's first address is not verified, and the one of hers that is, is Bob's
          // here: she signs in as neither.
          yield* person("Eve", "eve@example.test");
          yield* person("Bob", "bob@example.test");
          const eve = yield* Hub.signInThroughHub(control.url, HUB, "eve");
          expect(eve.at).toMatch(/^\/sign-in-refused\?error=/u);
          expect(yield* signedIn(eve.cookie)).toBe(false);
          expect(yield* through("eve@example.test")).toEqual([]);
          expect(yield* through("bob@example.test")).toEqual([]);
          // Nor does someone the hub tells no address of at all.
          const mallory = yield* Hub.signInThroughHub(control.url, HUB, "mallory");
          expect(mallory.at).toMatch(/^\/sign-in-refused\?error=/u);
          // Nobody an admin did not make a person is made one: it was not told to.
          const grace = yield* Hub.signInThroughHub(control.url, HUB, "grace");
          expect(grace.at).toMatch(/^\/sign-in-refused\?error=/u);
          expect(yield* through("grace@example.test")).toBeUndefined();
        }),
      );

      it.effect("told to, it makes people of those it verified, of its domains alone", () =>
        Effect.gen(function* () {
          const control = yield* Control.Control;
          const made = yield* asAdmin(
            "POST",
            PROVIDERS,
            yield* hub(HUB_OPEN, { name: "Open hub", provision: true, domains: ["example.test"] }),
          );
          expect(made.status).toBe(201);
          const grace = yield* Hub.signInThroughHub(control.url, HUB_OPEN, "grace");
          expect(grace.at).toBe("/-/sessions");
          expect(yield* signedIn(grace.cookie)).toBe(true);
          expect(yield* through("grace@example.test")).toEqual(["Open hub"]);
          const heidi = yield* Hub.signInThroughHub(control.url, HUB_OPEN, "heidi");
          expect(heidi.at).toMatch(/^\/sign-in-refused\?error=email_domain_refused/u);
          // An address nobody verified makes nobody a person, whatever its domain.
          const ivan = yield* Hub.signInThroughHub(control.url, HUB_OPEN, "ivan");
          expect(ivan.at).toMatch(/^\/sign-in-refused\?error=/u);
          expect(yield* through("ivan@example.test")).toBeUndefined();
        }),
      );

      it.effect(
        "each place it is asked at is asked as nobody, and has to answer as that place",
        () =>
          Effect.gen(function* () {
            const at = yield* Hub.Hub;
            const check = (endpoints: object) =>
              asAdmin("POST", `${PROVIDERS}/check`, {
                endpoints: { ...at.endpoints, ...endpoints },
              }).pipe(Effect.flatMap((answer) => Schema.decodeUnknownEffect(Checked)(answer.body)));
            expect(yield* check({})).toEqual({ ok: true, problems: [], scopes: [] });
            // Without where its addresses are listed, it is asked at three places.
            expect(yield* check({ emails: null })).toMatchObject({ ok: true });

            const nowhere = yield* check({ userInfo: `${at.url}/nowhere` });
            expect(nowhere.ok).toBe(false);
            expect(nowhere.problems).toHaveLength(1);
            expect(nowhere.problems[0]).toContain(`${at.url}/nowhere answered 404`);
            expect((yield* check({ authorization: `${at.url}/nowhere` })).problems[0]).toContain(
              "answered 404",
            );
            // A place that tells anyone anything is none that tells who a token is someone's.
            const open = yield* check({ emails: at.endpoints.authorization });
            expect(open.problems).toHaveLength(1);
            expect(open.problems[0]).toContain("has to ask who asks");
            // Each of what is wrong is said, and none is asked without TLS but on this machine.
            const several = yield* check({
              token: "http://provider.example/token",
              userInfo: "not an address",
            });
            expect(several.ok).toBe(false);
            expect(several.problems).toHaveLength(2);
            expect(several.problems.join(" ")).toContain("https://");

            // One that is to sign people in at once is held to it; kept disabled, it is not.
            const wrong = yield* hub(ANOTHER, {
              endpoints: { ...at.endpoints, userInfo: `${at.url}/nowhere` },
            });
            const refused = yield* asAdmin("POST", PROVIDERS, wrong);
            expect(refused.status).toBe(400);
            const why = yield* Schema.decodeUnknownEffect(Refused)(refused.body);
            expect(why._tag).toBe("ProviderInvalid");
            expect(why.problems[0]).toContain("/nowhere");
            const kept = yield* asAdmin("POST", PROVIDERS, { ...wrong, enabled: false });
            expect(kept).toMatchObject({ status: 201, body: { enabled: false, kind: "oauth2" } });
            expect(
              yield* asAdmin("PATCH", `${PROVIDERS}/${ANOTHER}`, { enabled: true }),
            ).toMatchObject({ status: 400, body: { _tag: "ProviderInvalid" } });
            yield* asAdmin("DELETE", `${PROVIDERS}/${ANOTHER}`);

            // Neither is one without what it speaks takes: places to ask at, or an issuer.
            const { endpoints: _, ...placeless } = yield* hub(ANOTHER);
            expect(yield* asAdmin("POST", PROVIDERS, placeless)).toMatchObject({
              status: 400,
              body: { _tag: "ProviderInvalid" },
            });
            expect(yield* asAdmin("POST", PROVIDERS, { ...placeless, kind: "oidc" })).toMatchObject(
              { status: 400, body: { _tag: "ProviderInvalid" } },
            );
          }),
      );

      it.effect("where it is asked is changed, and what it speaks stays", () =>
        Effect.gen(function* () {
          const control = yield* Control.Control;
          const at = yield* Hub.Hub;
          // Without the list of her addresses, nothing tells Ada's: the hub keeps it to itself.
          const changed = yield* asAdmin("PATCH", `${PROVIDERS}/${HUB}`, {
            endpoints: { ...at.endpoints, emails: "" },
          });
          expect(changed).toMatchObject({
            status: 200,
            body: { kind: "oauth2", endpoints: { ...at.endpoints, emails: null } },
          });
          const refused = yield* Hub.signInThroughHub(control.url, HUB, "ada");
          expect(refused.at).toMatch(/^\/sign-in-refused\?error=/u);
          yield* asAdmin("PATCH", `${PROVIDERS}/${HUB}`, { endpoints: at.endpoints });
          expect((yield* Hub.signInThroughHub(control.url, HUB, "ada")).at).toBe("/-/sessions");

          const events = yield* asAdmin(
            "GET",
            "/api/control/events?resourceKind=provider&limit=100",
          );
          expect(JSON.stringify(events.body)).toContain('"changed":["endpoints"]');
          const listed = yield* Schema.decodeUnknownEffect(Listed)(
            (yield* asAdmin("GET", PROVIDERS)).body,
          );
          expect(listed.providers.map((one) => one.id)).toEqual([HUB, HUB_OPEN]);
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
