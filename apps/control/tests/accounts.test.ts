import { suite } from "@aperture-browser/e2e/src/suite.ts";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Cookies from "effect/http/Cookies";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Control from "./src/control.ts";
import { totp } from "./src/totp.ts";

const OpenApi = Schema.Struct({
  openapi: Schema.String,
  paths: Schema.Record(Schema.String, Schema.Unknown),
});

/** The cookies an answer sets, as a browser sends them back; what it takes back is left out. */
const cookiesOf = (answer: HttpClientResponse.HttpClientResponse) =>
  Object.entries(Cookies.toRecord(answer.cookies))
    .filter(([, value]) => value !== "")
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("; ");

const Enabled = Schema.Struct({
  totpURI: Schema.String,
  backupCodes: Schema.Array(Schema.String),
});

for (const stores of Control.STORES) {
  suite(Control.layer({ stores }))(`accounts and their tokens, kept in ${stores}`, (it) => {
    it.effect("the bootstrap token makes an account and a token that works", () =>
      Effect.gen(function* () {
        const ada = yield* Control.account("Ada");
        expect(ada.token).toMatch(/^apc_/u);
        expect(ada.account).toMatchObject({ name: "Ada", admin: false });

        const current = yield* ada.api.accounts.current();
        expect(current.id).toBe(ada.account.id);
      }),
    );

    // What memory keeps is read by nobody else.
    it.effect.skipIf(stores === "memory")("a token is kept as its digest alone", () =>
      Effect.gen(function* () {
        const control = yield* Control.Control;
        const sql = Option.getOrThrow(control.sql);
        const grace = yield* Control.account("Grace");
        const kept = yield* sql`SELECT * FROM api_tokens`;
        expect(kept.length).toBeGreaterThan(0);
        expect(JSON.stringify(kept)).not.toContain(grace.token);
      }),
    );

    it.effect("a token that is nobody's is refused, and so is none", () =>
      Effect.gen(function* () {
        const control = yield* Control.Control;
        const wrong = yield* control.as("apc_not-a-token");
        expect((yield* Effect.flip(wrong.accounts.current()))._tag).toBe("Unauthorized");

        const none = yield* control.request("", "GET", "/api/control/sessions");
        expect(none.status).toBe(401);
        const unknown = yield* control.request("apc_not-a-token", "GET", "/api/control/sessions");
        expect(unknown.status).toBe(401);
      }),
    );

    it.effect("an account makes, lists and takes back its own tokens", () =>
      Effect.gen(function* () {
        const control = yield* Control.Control;
        const lin = yield* Control.account("Lin");
        const made = yield* lin.api.accounts.createOwnToken({
          payload: { name: "ci", expiresInDays: 7 },
        });
        expect(made.token).toMatch(/^apc_/u);
        expect(made.expiresAt).not.toBeNull();
        expect((yield* lin.api.accounts.tokens()).map((token) => token.name)).toEqual([
          "checks",
          "ci",
        ]);

        const withIt = yield* control.as(made.token);
        expect((yield* withIt.accounts.current()).id).toBe(lin.account.id);

        // Another account's token is none of theirs to take back.
        const eve = yield* Control.account("Eve");
        const refused = yield* Effect.flip(
          eve.api.accounts.revokeToken({ params: { id: made.id } }),
        );
        expect(refused._tag).toBe("ApiTokenNotFound");

        yield* lin.api.accounts.revokeToken({ params: { id: made.id } });
        expect((yield* Effect.flip(withIt.accounts.current()))._tag).toBe("Unauthorized");
        const kept = (yield* lin.api.accounts.tokens()).find((token) => token.id === made.id);
        expect(kept?.revokedAt).not.toBeNull();
      }),
    );

    it.effect(
      "a person sets a password with a setup token, signs in, and is who the cookies say",
      () =>
        Effect.gen(function* () {
          const control = yield* Control.Control;
          const http = yield* HttpClient.HttpClient;
          const bootstrap = yield* control.as(control.bootstrapToken);
          const email = `mira-${stores}@example.test`;
          const mira = yield* bootstrap.accounts.create({ payload: { name: "Mira", email } });
          expect(mira).toMatchObject({ kind: "person", email });
          const again = yield* Effect.flip(
            bootstrap.accounts.create({ payload: { name: "Mira", email } }),
          );
          expect(again._tag).toBe("EmailTaken");

          const post = (path: string, body: object) =>
            http.execute(
              HttpClientRequest.post(`${control.url}${path}`).pipe(
                HttpClientRequest.setHeader("origin", control.url),
                HttpClientRequest.bodyJsonUnsafe(body),
              ),
            );
          // Nobody makes themselves a person, and nobody signs in before a password is set.
          const password = "a password of Mira's own";
          expect(
            (yield* post("/api/auth/sign-up/email", {
              email: "x@example.test",
              name: "X",
              password,
            })).status,
          ).toBe(404);
          expect((yield* post("/api/auth/sign-in/email", { email, password })).status).toBe(401);

          const { token } = yield* bootstrap.accounts.createSetupToken({ params: { id: mira.id } });
          expect(
            (yield* post("/api/auth/reset-password", { token, newPassword: password })).status,
          ).toBe(200);
          const signedIn = yield* post("/api/auth/sign-in/email", { email, password });
          expect(signedIn.status).toBe(200);
          const cookie = cookiesOf(signedIn);
          expect(cookie).not.toBe("");

          const current = yield* http.execute(
            HttpClientRequest.get(`${control.url}/api/control/account`).pipe(
              HttpClientRequest.setHeader("cookie", cookie),
            ),
          );
          expect(current.status).toBe(200);
          expect(yield* current.json).toMatchObject({ id: mira.id, name: "Mira" });
          // No cookies, no person.
          expect((yield* http.get(`${control.url}/api/control/account`)).status).toBe(401);
        }),
    );

    it.effect(
      "a person who turned a second factor on signs in with a code or a backup code, not without",
      () =>
        Effect.gen(function* () {
          const control = yield* Control.Control;
          const http = yield* HttpClient.HttpClient;
          const bootstrap = yield* control.as(control.bootstrapToken);
          const email = `noor-${stores}@example.test`;
          const password = "a password of Noor's own";
          const noor = yield* bootstrap.accounts.create({ payload: { name: "Noor", email } });
          const { token } = yield* bootstrap.accounts.createSetupToken({ params: { id: noor.id } });

          const post = (path: string, body: object, cookie = "") =>
            http.execute(
              HttpClientRequest.post(`${control.url}/api/auth${path}`).pipe(
                HttpClientRequest.setHeader("origin", control.url),
                HttpClientRequest.setHeader("cookie", cookie),
                HttpClientRequest.bodyJsonUnsafe(body),
              ),
            );
          const account = (cookie: string) =>
            http
              .execute(
                HttpClientRequest.get(`${control.url}/api/control/account`).pipe(
                  HttpClientRequest.setHeader("cookie", cookie),
                ),
              )
              .pipe(Effect.map((answer) => answer.status));
          /** The password alone: it signs nobody in, and leaves cookies to go on with. */
          const half = Effect.gen(function* () {
            const answer = yield* post("/sign-in/email", { email, password });
            expect(answer.status).toBe(200);
            expect(yield* answer.json).toMatchObject({ twoFactorRedirect: true });
            const cookie = cookiesOf(answer);
            expect(yield* account(cookie)).toBe(401);
            return cookie;
          });

          yield* post("/reset-password", { token, newPassword: password });
          const first = cookiesOf(yield* post("/sign-in/email", { email, password }));
          expect(yield* account(first)).toBe(200);

          // Turning it on takes the password, and a code that shows the authenticator has the secret.
          expect((yield* post("/two-factor/enable", { password: "not hers" }, first)).status).toBe(
            400,
          );
          const enabling = yield* post("/two-factor/enable", { password }, first);
          expect(enabling.status).toBe(200);
          const { totpURI, backupCodes } = yield* Schema.decodeUnknownEffect(Enabled)(
            yield* enabling.json,
          );
          expect(totpURI).toMatch(/^otpauth:\/\/totp\/Aperture:/u);
          expect(backupCodes.length).toBeGreaterThan(1);
          const confirmed = yield* post(
            "/two-factor/verify-totp",
            { code: yield* totp(totpURI) },
            first,
          );
          expect(confirmed.status).toBe(200);
          // Whoever was signed in stays so, with cookies that are told anew.
          const second = cookiesOf(confirmed);
          expect(yield* account(second)).toBe(200);

          // Neither the secret nor a backup code is kept as it is told.
          if (Option.isSome(control.sql)) {
            const sql = control.sql.value;
            const kept = JSON.stringify([
              yield* sql`SELECT * FROM "twoFactor"`,
              yield* sql`SELECT * FROM accounts`,
            ]);
            expect(kept).toContain("secret");
            expect(kept).not.toContain(new URL(totpURI).searchParams.get("secret"));
            for (const code of backupCodes) {
              expect(kept).not.toContain(code);
            }
          }

          expect((yield* post("/sign-out", {}, second)).status).toBe(200);
          expect(yield* account(second)).toBe(401);

          const withCode = yield* half;
          const right = yield* totp(totpURI);
          const wrong = right === "000000" ? "000001" : "000000";
          expect((yield* post("/two-factor/verify-totp", { code: wrong }, withCode)).status).toBe(
            401,
          );
          const coded = yield* post("/two-factor/verify-totp", { code: right }, withCode);
          expect(coded.status).toBe(200);
          expect(yield* account(cookiesOf(coded))).toBe(200);
          yield* post("/sign-out", {}, cookiesOf(coded));

          // A backup code stands in for the authenticator, once.
          const [backup = ""] = backupCodes;
          const backed = yield* post(
            "/two-factor/verify-backup-code",
            { code: backup },
            yield* half,
          );
          expect(backed.status).toBe(200);
          expect(yield* account(cookiesOf(backed))).toBe(200);
          yield* post("/sign-out", {}, cookiesOf(backed));
          const spent = yield* post(
            "/two-factor/verify-backup-code",
            { code: backup },
            yield* half,
          );
          expect(spent.status).toBe(401);
          expect(yield* account(cookiesOf(spent))).toBe(401);

          // Whoever lost the authenticator and the codes is let back in by an admin: the
          // second factor is off, and the password is the one it was.
          const ada = yield* Control.account(`Ada-${stores}`);
          const notHers = yield* Effect.flip(
            ada.api.accounts.resetSecondFactor({ params: { id: noor.id } }),
          );
          expect(notHers._tag).toBe("Forbidden");
          yield* bootstrap.accounts.resetSecondFactor({ params: { id: noor.id } });
          const plainly = yield* post("/sign-in/email", { email, password });
          expect(yield* plainly.json).not.toMatchObject({ twoFactorRedirect: true });
          expect(yield* account(cookiesOf(plainly))).toBe(200);
        }),
    );

    it.effect("a token held to scopes does what they name, and makes none that does more", () =>
      Effect.gen(function* () {
        const control = yield* Control.Control;
        const root = yield* Control.account(`Root-${stores}`, true);
        const reader = yield* root.api.accounts.createOwnToken({
          payload: { name: "reader", scopes: ["sessions:read"] },
        });
        expect(reader.scopes).toEqual(["sessions:read"]);
        const asReader = yield* control.as(reader.token);

        expect(yield* asReader.sessions.list()).toEqual([]);
        const writes = yield* Effect.flip(asReader.sessions.create({ payload: {} }));
        expect(writes).toMatchObject({ _tag: "Forbidden" });
        expect((yield* Effect.flip(asReader.snapshots.list()))._tag).toBe("Forbidden");
        // It is of an admin's account, and not an admin's: it was not made for that.
        expect((yield* Effect.flip(asReader.accounts.list()))._tag).toBe("Forbidden");
        expect((yield* Effect.flip(asReader.accounts.tokens()))._tag).toBe("Forbidden");

        const maker = yield* root.api.accounts.createOwnToken({
          payload: { name: "maker", scopes: ["tokens:write", "snapshots:write"] },
        });
        const asMaker = yield* control.as(maker.token);
        // Writing snapshots includes reading them.
        expect(yield* asMaker.snapshots.list()).toEqual([]);
        const more = yield* Effect.flip(
          asMaker.accounts.createOwnToken({ payload: { name: "more", scopes: ["admin"] } }),
        );
        expect(more._tag).toBe("Forbidden");
        const unheld = yield* Effect.flip(
          asMaker.accounts.createOwnToken({ payload: { name: "all" } }),
        );
        expect(unheld._tag).toBe("Forbidden");
        const less = yield* asMaker.accounts.createOwnToken({
          payload: { name: "less", scopes: ["snapshots:read"] },
        });
        expect(less.scopes).toEqual(["snapshots:read"]);
      }),
    );

    it.effect("an account that is no admin makes neither accounts nor tokens", () =>
      Effect.gen(function* () {
        const ada = yield* Control.account("Ada");
        const refused = yield* Effect.flip(ada.api.accounts.create({ payload: { name: "Eve" } }));
        expect(refused._tag).toBe("Forbidden");
        const own = yield* Effect.flip(
          ada.api.accounts.createToken({
            params: { id: ada.account.id },
            payload: { name: "more" },
          }),
        );
        expect(own._tag).toBe("Forbidden");
        expect((yield* Effect.flip(ada.api.accounts.list()))._tag).toBe("Forbidden");
      }),
    );

    it.effect("an admin account makes accounts and tokens as the bootstrap token does", () =>
      Effect.gen(function* () {
        const control = yield* Control.Control;
        const root = yield* Control.account("Root", true);
        const made = yield* root.api.accounts.create({ payload: { name: "Linus" } });
        const token = yield* root.api.accounts.createToken({
          params: { id: made.id },
          payload: { name: "laptop" },
        });
        const linus = yield* control.as(token.token);
        expect((yield* linus.accounts.current()).name).toBe("Linus");

        const all = yield* root.api.accounts.list();
        expect(all.map((account) => account.name)).toContain("Linus");

        const missing = yield* Effect.flip(
          root.api.accounts.createToken({
            params: { id: "00000000-0000-7000-8000-000000000000" },
            payload: { name: "nobody's" },
          }),
        );
        expect(missing._tag).toBe("AccountNotFound");
      }),
    );

    it.effect("the bootstrap token is an admin's and no account's", () =>
      Effect.gen(function* () {
        const control = yield* Control.Control;
        const bootstrap = yield* control.as(control.bootstrapToken);
        expect((yield* Effect.flip(bootstrap.accounts.current()))._tag).toBe("Forbidden");
        expect((yield* Effect.flip(bootstrap.sessions.create({ payload: {} })))._tag).toBe(
          "Forbidden",
        );
      }),
    );

    it.effect("the API is described where its clients look for it", () =>
      Effect.gen(function* () {
        const control = yield* Control.Control;
        const answer = yield* control.request("", "GET", "/api/control/openapi.json");
        expect(answer.status).toBe(200);
        const described = yield* Schema.decodeUnknownEffect(OpenApi)(answer.body);
        expect(Object.keys(described.paths)).toEqual(
          expect.arrayContaining([
            "/api/control/accounts",
            "/api/control/sessions",
            "/api/control/sessions/{id}/tickets",
          ]),
        );
      }),
    );
  });
}
