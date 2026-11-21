import { request } from "@aperture-browser/e2e/src/http.ts";
import { suite } from "@aperture-browser/e2e/src/suite.ts";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Control from "./src/control.ts";
import * as Dex from "./src/dex.ts";
import { signInThrough } from "./src/sso.ts";

const Current = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.String,
  admin: Schema.Boolean,
  email: Schema.NullOr(Schema.String),
});
const NEW_PASSWORD = "a password set after the first sign-in";

const needs = (options: Control.ControlOptions) =>
  Dex.layer.pipe(Layer.provideMerge(Control.layer(options)), Layer.provideMerge(Dex.address));

/** The account a browser's cookies sign in, as the API tells it. */
const accountOf = Effect.fn(function* (cookie: string) {
  const control = yield* Control.Control;
  const http = yield* HttpClient.HttpClient;
  const answer = yield* http.execute(
    HttpClientRequest.get(`${control.url}/api/control/account`).pipe(
      HttpClientRequest.setHeader("cookie", cookie),
    ),
  );
  return { status: answer.status, body: yield* answer.json };
});

const withPassword = Effect.fn(function* (email: string, password: string) {
  const control = yield* Control.Control;
  const http = yield* HttpClient.HttpClient;
  const answer = yield* http.execute(
    HttpClientRequest.post(`${control.url}/api/auth/sign-in/email`).pipe(
      HttpClientRequest.setHeader("origin", control.url),
      HttpClientRequest.bodyJsonUnsafe({ email, password }),
    ),
  );
  return answer.status;
});

for (const stores of Control.STORES) {
  suite(needs({ stores, sso: {} }))(
    `signing in through a provider, which makes nobody a person, kept in ${stores}`,
    (it) => {
      it.effect("whoever is not signed in is told the providers, and nothing else of them", () =>
        Effect.gen(function* () {
          const control = yield* Control.Control;
          const answer = yield* request(control.url, "", "GET", "/api/control/sign-in/providers");
          expect(answer).toEqual({
            status: 200,
            body: [{ id: Dex.PROVIDER, name: Dex.PROVIDER_NAME }],
          });
        }),
      );

      it.effect("a person an admin made signs in through it, and lands where they were going", () =>
        Effect.gen(function* () {
          const control = yield* Control.Control;
          const bootstrap = yield* control.as(control.bootstrapToken);
          const [ada] = Dex.VERIFIED;
          const made = yield* bootstrap.accounts.create({
            payload: { name: "Ada Lovelace", email: ada.email },
          });
          const going = "/oauth/consent?client_id=an-app&state=its-own";
          const landed = yield* signInThrough(control.url, "local", ada.email, going);
          expect(landed.at).toBe(going);
          const account = yield* accountOf(landed.cookie);
          expect(account.status).toBe(200);
          // The account the admin made, as the admin named it: the provider renames nobody.
          expect(yield* Schema.decodeUnknownEffect(Current)(account.body)).toMatchObject({
            id: made.id,
            name: "Ada Lovelace",
            email: ada.email,
          });
          // Again: the provider's own word for who it is, and not the address, finds them now.
          const again = yield* signInThrough(control.url, "local", ada.email);
          expect(again.at).toBe("/-/sessions");
          expect((yield* accountOf(again.cookie)).status).toBe(200);
        }),
      );

      it.effect("someone no admin made a person is refused, and stays nobody", () =>
        Effect.gen(function* () {
          const control = yield* Control.Control;
          const bootstrap = yield* control.as(control.bootstrapToken);
          const [, bob] = Dex.VERIFIED;
          const before = yield* bootstrap.accounts.list();
          const landed = yield* signInThrough(control.url, "local", bob.email);
          expect(landed.at).toBe("/sign-in-refused?error=signup_disabled");
          expect((yield* accountOf(landed.cookie)).status).toBe(401);
          expect(yield* bootstrap.accounts.list()).toHaveLength(before.length);
        }),
      );

      it.effect("a person whose address the provider did not verify is refused", () =>
        Effect.gen(function* () {
          const control = yield* Control.Control;
          const bootstrap = yield* control.as(control.bootstrapToken);
          const [eve] = Dex.UNVERIFIED;
          yield* bootstrap.accounts.create({ payload: { name: "Eve", email: eve } });
          const landed = yield* signInThrough(control.url, "unverified", eve);
          expect(landed.at).toBe("/sign-in-refused?error=account_not_linked");
          expect((yield* accountOf(landed.cookie)).status).toBe(401);
        }),
      );
    },
  );

  suite(needs({ stores, sso: { provision: true, domains: ["example.test"] } }))(
    `signing in through a provider that makes people of one domain, kept in ${stores}`,
    (it) => {
      it.effect("whom it vouches for is made a person when they first sign in, and once", () =>
        Effect.gen(function* () {
          const control = yield* Control.Control;
          const bootstrap = yield* control.as(control.bootstrapToken);
          const [, bob] = Dex.VERIFIED;
          const landed = yield* signInThrough(control.url, "local", bob.email);
          expect(landed.at).toBe("/-/sessions");
          const first = yield* Schema.decodeUnknownEffect(Current)(
            (yield* accountOf(landed.cookie)).body,
          );
          expect(first).toMatchObject({
            name: bob.name,
            kind: "person",
            admin: false,
            email: bob.email,
          });
          const again = yield* signInThrough(control.url, "local", bob.email);
          expect(
            (yield* Schema.decodeUnknownEffect(Current)((yield* accountOf(again.cookie)).body)).id,
          ).toBe(first.id);
          const theirs = (yield* bootstrap.accounts.list()).filter(
            (account) => account.email === bob.email,
          );
          expect(theirs).toHaveLength(1);

          // They have no password until they set one, with a setup link as anyone does.
          expect(yield* withPassword(bob.email, Dex.PASSWORD)).toBe(401);
          const { token } = yield* bootstrap.accounts.createSetupToken({
            params: { id: first.id },
          });
          const http = yield* HttpClient.HttpClient;
          yield* http.execute(
            HttpClientRequest.post(`${control.url}/api/auth/reset-password`).pipe(
              HttpClientRequest.setHeader("origin", control.url),
              HttpClientRequest.bodyJsonUnsafe({ token, newPassword: NEW_PASSWORD }),
            ),
          );
          expect(yield* withPassword(bob.email, NEW_PASSWORD)).toBe(200);
        }),
      );

      it.effect("an address of another domain is refused", () =>
        Effect.gen(function* () {
          const control = yield* Control.Control;
          const bootstrap = yield* control.as(control.bootstrapToken);
          const [, , carol] = Dex.VERIFIED;
          const landed = yield* signInThrough(control.url, "local", carol.email);
          expect(landed.at).toMatch(/^\/sign-in-refused\?error=email_domain_refused/u);
          expect((yield* accountOf(landed.cookie)).status).toBe(401);
          expect(
            (yield* bootstrap.accounts.list()).some((account) => account.email === carol.email),
          ).toBe(false);
        }),
      );

      it.effect("an address the provider did not verify makes nobody a person", () =>
        Effect.gen(function* () {
          const control = yield* Control.Control;
          const bootstrap = yield* control.as(control.bootstrapToken);
          const [, mallory] = Dex.UNVERIFIED;
          const landed = yield* signInThrough(control.url, "unverified", mallory);
          expect(landed.at).toMatch(/^\/sign-in-refused\?error=email_not_verified/u);
          expect((yield* accountOf(landed.cookie)).status).toBe(401);
          expect(
            (yield* bootstrap.accounts.list()).some((account) => account.email === mallory),
          ).toBe(false);
          // Nor is anything kept of them that a later sign-in would find.
          const later = yield* signInThrough(control.url, "unverified", mallory);
          expect(later.at).toMatch(/^\/sign-in-refused\?error=email_not_verified/u);
        }),
      );

      it.effect("a person an admin made needs no domain", () =>
        Effect.gen(function* () {
          const control = yield* Control.Control;
          const bootstrap = yield* control.as(control.bootstrapToken);
          const [, , carol] = Dex.VERIFIED;
          const made = yield* bootstrap.accounts.create({
            payload: { name: "Carol", email: carol.email },
          });
          const landed = yield* signInThrough(control.url, "local", carol.email);
          expect(landed.at).toBe("/-/sessions");
          expect(
            (yield* Schema.decodeUnknownEffect(Current)((yield* accountOf(landed.cookie)).body)).id,
          ).toBe(made.id);
        }),
      );
    },
  );
}
