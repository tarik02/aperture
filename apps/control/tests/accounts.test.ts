import { suite } from "@aperture-browser/e2e/src/suite.ts";
import { expect } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schema from "effect/Schema";
import * as Control from "./src/control.ts";
import { cookiesOf, signedIn } from "./src/person.ts";
import { totp } from "./src/totp.ts";

const OpenApi = Schema.Struct({
  openapi: Schema.String,
  paths: Schema.Record(Schema.String, Schema.Unknown),
});

const Enabled = Schema.Struct({
  totpURI: Schema.String,
  backupCodes: Schema.Array(Schema.String),
});

suite(Control.layer())("accounts and their tokens", (it) => {
  it.effect("the bootstrap token makes an account and a token that works", () =>
    Effect.gen(function* () {
      const ada = yield* Control.account("Ada");
      expect(ada.token).toMatch(/^apc_/u);
      expect(ada.account).toMatchObject({ name: "Ada", admin: false });

      const current = yield* ada.api.accounts.current();
      expect(current.id).toBe(ada.account.id);
    }),
  );

  it.effect("a token is kept as its digest alone", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const { sql } = control;
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
        payload: { name: "ci", expiresInDays: 7, scopes: Control.ALL_SCOPES },
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
      const refused = yield* Effect.flip(eve.api.accounts.revokeToken({ params: { id: made.id } }));
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
        const email = `mira@example.test`;
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
        const email = `noor@example.test`;
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
        const kept = JSON.stringify([
          yield* control.sql`SELECT * FROM "twoFactor"`,
          yield* control.sql`SELECT * FROM accounts`,
        ]);
        expect(kept).toContain("secret");
        expect(kept).not.toContain(new URL(totpURI).searchParams.get("secret"));
        for (const code of backupCodes) {
          expect(kept).not.toContain(code);
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
        const backed = yield* post("/two-factor/verify-backup-code", { code: backup }, yield* half);
        expect(backed.status).toBe(200);
        expect(yield* account(cookiesOf(backed))).toBe(200);
        yield* post("/sign-out", {}, cookiesOf(backed));
        const spent = yield* post("/two-factor/verify-backup-code", { code: backup }, yield* half);
        expect(spent.status).toBe(401);
        expect(yield* account(cookiesOf(spent))).toBe(401);

        // Whoever lost the authenticator and the codes is let back in by an admin: the
        // second factor is off, and the password is the one it was.
        const ada = yield* Control.account(`Ada`);
        const notHers = yield* Effect.flip(
          ada.api.accounts.resetSecondFactor({ params: { id: noor.id } }),
        );
        expect(notHers._tag).toBe("Forbidden");
        yield* bootstrap.accounts.resetSecondFactor({ params: { id: noor.id } });
        const plainly = yield* post("/sign-in/email", { email, password });
        expect(yield* plainly.json).not.toMatchObject({ twoFactorRedirect: true });
        expect(yield* account(cookiesOf(plainly))).toBe(200);

        // Each time they were signed in is recorded with what they proved themselves by:
        // the password alone signed nobody in while a code was asked after it, and the
        // code that turned the second factor on did not either.
        const signIns = yield* bootstrap.events.list({
          query: { kind: "sign_in.succeeded", resourceId: noor.id },
        });
        const methods = signIns.events.map((event) => event.detail["method"]);
        expect(methods.slice(0, 3)).toEqual(["password", "two_factor", "two_factor"]);
        expect(methods.filter((method) => method === "two_factor")).toHaveLength(2);
        const refused = yield* bootstrap.events.list({ query: { kind: "sign_in.failed" } });
        expect(
          refused.events.filter((event) => event.detail["method"] === "two_factor").length,
        ).toBeGreaterThanOrEqual(2);

        // Passkeys are kept where the rest of a person is, and an admin alone removes
        // them without the person; a service account has none to remove.
        const passkeys = yield* http.execute(
          HttpClientRequest.get(`${control.url}/api/auth/passkey/list-user-passkeys`).pipe(
            HttpClientRequest.setHeader("cookie", cookiesOf(plainly)),
          ),
        );
        expect([passkeys.status, yield* passkeys.json]).toEqual([200, []]);
        expect(
          (yield* Effect.flip(ada.api.accounts.removePasskeys({ params: { id: noor.id } })))._tag,
        ).toBe("Forbidden");
        yield* bootstrap.accounts.removePasskeys({ params: { id: noor.id } });
        expect(
          (yield* Effect.flip(
            bootstrap.accounts.removePasskeys({ params: { id: ada.account.id } }),
          ))._tag,
        ).toBe("PersonNotFound");
      }),
  );

  it.effect("a token held to scopes does what they name, and makes none that does more", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const root = yield* Control.account(`Root`, true);
      const reader = yield* root.api.accounts.createOwnToken({
        payload: { name: "reader", scopes: ["sessions:read"] },
      });
      expect(reader.scopes).toEqual(["sessions:read"]);
      const asReader = yield* control.as(reader.token);

      expect(yield* asReader.sessions.list({ query: {} })).toEqual([]);
      const writes = yield* Effect.flip(asReader.sessions.create({ payload: {} }));
      expect(writes).toMatchObject({ _tag: "Forbidden" });
      expect((yield* Effect.flip(asReader.snapshots.list({ query: {} })))._tag).toBe("Forbidden");
      // It is of an admin's account, and not an admin's: it was not made for that.
      expect((yield* Effect.flip(asReader.accounts.list()))._tag).toBe("Forbidden");
      expect((yield* Effect.flip(asReader.accounts.tokens()))._tag).toBe("Forbidden");

      const maker = yield* root.api.accounts.createOwnToken({
        payload: { name: "maker", scopes: ["tokens:write", "snapshots:write"] },
      });
      const asMaker = yield* control.as(maker.token);
      // Writing snapshots includes reading them.
      expect(yield* asMaker.snapshots.list({ query: {} })).toEqual([]);
      const more = yield* Effect.flip(
        asMaker.accounts.createOwnToken({ payload: { name: "more", scopes: ["admin"] } }),
      );
      expect(more._tag).toBe("Forbidden");
      const less = yield* asMaker.accounts.createOwnToken({
        payload: { name: "less", scopes: ["snapshots:read"] },
      });
      expect(less.scopes).toEqual(["snapshots:read"]);
    }),
  );

  it.effect("a caller is told what it is held to, and one that signed in is held to nothing", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const http = yield* HttpClient.HttpClient;
      const root = yield* Control.account(`Held`, true);
      expect(yield* root.api.accounts.current()).toMatchObject({
        admin: true,
        scopes: Control.ALL_SCOPES,
        resources: null,
      });

      const free = yield* root.api.accounts.createToken({
        params: { id: root.account.id },
        payload: { name: "reader", scopes: ["sessions:read"] },
      });
      // Still an admin's account, and the token says what it is for itself.
      expect(yield* (yield* control.as(free.token)).accounts.current()).toMatchObject({
        id: root.account.id,
        admin: true,
        scopes: ["sessions:read"],
        resources: null,
      });

      const held = { workspaces: [], sessions: ["one-session"], snapshots: [] };
      const narrow = yield* root.api.accounts.createOwnToken({
        payload: { name: "narrow", scopes: ["sessions:write"], resources: held },
      });
      expect(yield* (yield* control.as(narrow.token)).accounts.current()).toMatchObject({
        scopes: ["sessions:write"],
        resources: held,
      });

      const person = yield* signedIn("Held", `held@example.test`);
      const current = yield* http.execute(
        HttpClientRequest.get(`${control.url}/api/control/account`).pipe(
          HttpClientRequest.setHeader("cookie", person.cookie),
        ),
      );
      expect(yield* current.json).toMatchObject({
        id: person.account.id,
        scopes: null,
        resources: null,
      });
    }),
  );

  it.effect("an admin reads one account, renames it and says whether it is an admin's", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const root = yield* Control.account(`Changer`, true);
      const bot = yield* root.api.accounts.create({ payload: { name: "Bot" } });
      const at = { params: { id: bot.id } };
      expect(yield* root.api.accounts.get(at)).toMatchObject({
        id: bot.id,
        name: "Bot",
        kind: "service",
        admin: false,
        signIn: null,
      });

      const renamed = yield* root.api.accounts.change({ ...at, payload: { name: "Crawler" } });
      expect(renamed).toMatchObject({ name: "Crawler", admin: false });
      const raised = yield* root.api.accounts.change({ ...at, payload: { admin: true } });
      expect(raised).toMatchObject({ name: "Crawler", admin: true });
      expect((yield* root.api.accounts.get(at)).admin).toBe(true);
      const events = yield* root.api.events.list({
        query: { kind: "account.changed", resourceId: bot.id },
      });
      expect(events.events.map((event) => event.detail)).toEqual([
        { admin: true },
        { from: "Bot" },
      ]);
      // What is said as it is already is no change, and is not written down as one.
      yield* root.api.accounts.change({ ...at, payload: { name: "Crawler", admin: true } });
      expect(
        (yield* root.api.events.list({ query: { kind: "account.changed", resourceId: bot.id } }))
          .events.length,
      ).toBe(2);
      yield* root.api.accounts.change({ ...at, payload: { admin: false } });

      // Nobody says of their own account whether it is an admin's; its name they say.
      const own = { params: { id: root.account.id } };
      const self = yield* Effect.flip(
        root.api.accounts.change({ ...own, payload: { admin: false } }),
      );
      expect(self._tag).toBe("Forbidden");
      expect((yield* root.api.accounts.change({ ...own, payload: { name: "Root" } })).name).toBe(
        "Root",
      );

      const eve = yield* Control.account(`Plain`);
      expect((yield* Effect.flip(eve.api.accounts.get(at)))._tag).toBe("Forbidden");
      expect(
        (yield* Effect.flip(eve.api.accounts.get({ params: { id: eve.account.id } })))._tag,
      ).toBe("Forbidden");
      const notTheirs = yield* Effect.flip(
        eve.api.accounts.change({ ...at, payload: { admin: true } }),
      );
      expect(notTheirs._tag).toBe("Forbidden");
      // An admin's token that is not for an admin's doings does none of them.
      const plain = yield* root.api.accounts.createOwnToken({
        payload: { name: "plain", scopes: ["sessions:write", "workspaces:write"] },
      });
      const asPlain = yield* control.as(plain.token);
      expect((yield* Effect.flip(asPlain.accounts.get(at)))._tag).toBe("Forbidden");
      expect(
        (yield* Effect.flip(asPlain.accounts.change({ ...at, payload: { name: "Theirs" } })))._tag,
      ).toBe("Forbidden");

      const nobody = { params: { id: "00000000-0000-7000-8000-000000000000" } };
      expect((yield* Effect.flip(root.api.accounts.get(nobody)))._tag).toBe("AccountNotFound");
      expect(
        (yield* Effect.flip(root.api.accounts.change({ ...nobody, payload: { name: "None" } })))
          ._tag,
      ).toBe("AccountNotFound");
      expect((yield* root.api.accounts.get(at)).name).toBe("Crawler");
    }),
  );

  it.effect("who is in a workspace is told to a token that reads workspaces, and to no other", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const lead = yield* Control.account(`Lead`);
      const team = yield* lead.api.workspaces.create({ payload: { name: "Readers" } });
      const other = yield* lead.api.workspaces.create({ payload: { name: "Others" } });
      const token = (scopes: readonly ["sessions:write" | "workspaces:read"]) =>
        lead.api.accounts
          .createOwnToken({ payload: { name: "held", scopes } })
          .pipe(Effect.flatMap((made) => control.as(made.token)));

      // Which workspaces its account is in is told to any token: it is who the caller is.
      const sessionsOnly = yield* token(["sessions:write"]);
      expect((yield* sessionsOnly.workspaces.list()).map((one) => one.name).sort()).toEqual([
        "Others",
        "Readers",
      ]);
      const refused = yield* Effect.flip(
        sessionsOnly.workspaces.members({ params: { id: team.id } }),
      );
      expect(refused).toMatchObject({
        _tag: "Forbidden",
        message: expect.stringMatching(/workspaces:read/u),
      });

      const reader = yield* token(["workspaces:read"]);
      expect(
        (yield* reader.workspaces.members({ params: { id: team.id } })).map((one) => one.accountId),
      ).toEqual([lead.account.id]);
      // Reading is not writing.
      expect(
        (yield* Effect.flip(reader.workspaces.create({ payload: { name: "More" } })))._tag,
      ).toBe("Forbidden");
      expect(
        (yield* Effect.flip(
          reader.workspaces.rename({ params: { id: team.id }, payload: { name: "Theirs" } }),
        ))._tag,
      ).toBe("Forbidden");

      // A token held to one workspace is told of that one, and of nobody in another.
      const bootstrap = yield* control.as(control.bootstrapToken);
      const narrow = yield* bootstrap.accounts.createToken({
        params: { id: lead.account.id },
        payload: {
          name: "narrow",
          scopes: ["workspaces:write", "tokens:write"],
          resources: { workspaces: [team.id], sessions: [], snapshots: [] },
        },
      });
      const asNarrow = yield* control.as(narrow.token);
      expect((yield* asNarrow.workspaces.list()).map((one) => one.id)).toEqual([team.id]);
      expect((yield* asNarrow.workspaces.members({ params: { id: team.id } })).length).toBe(1);
      expect(
        (yield* Effect.flip(asNarrow.workspaces.members({ params: { id: other.id } })))._tag,
      ).toBe("WorkspaceNotFound");
      expect(
        (yield* Effect.flip(
          asNarrow.workspaces.rename({ params: { id: other.id }, payload: { name: "Theirs" } }),
        ))._tag,
      ).toBe("WorkspaceNotFound");
      // It makes no tokens, and takes none back either.
      const kept = (yield* lead.api.accounts.tokens()).find((one) => one.name === "checks");
      const taken = yield* Effect.flip(
        asNarrow.accounts.revokeToken({ params: { id: kept?.id ?? "" } }),
      );
      expect(taken._tag).toBe("Forbidden");
      expect((yield* lead.api.accounts.current()).id).toBe(lead.account.id);
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
          payload: { name: "more", scopes: Control.ALL_SCOPES },
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
        payload: { name: "laptop", scopes: Control.ALL_SCOPES },
      });
      const linus = yield* control.as(token.token);
      expect((yield* linus.accounts.current()).name).toBe("Linus");

      const all = yield* root.api.accounts.list();
      expect(all.map((account) => account.name)).toContain("Linus");

      const missing = yield* Effect.flip(
        root.api.accounts.createToken({
          params: { id: "00000000-0000-7000-8000-000000000000" },
          payload: { name: "nobody's", scopes: Control.ALL_SCOPES },
        }),
      );
      expect(missing._tag).toBe("AccountNotFound");
    }),
  );

  it.effect("a token that runs out makes none that outlives it", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const kay = yield* Control.account("Kay", true);
      const brief = yield* kay.api.accounts.createOwnToken({
        payload: { name: "for a day", expiresInDays: 1, scopes: Control.ALL_SCOPES },
      });
      const ends = DateTime.toEpochMillis(brief.expiresAt ?? DateTime.makeUnsafe(0));
      const withIt = yield* control.as(brief.token);
      const outlasts = (made: { readonly expiresAt: DateTime.Utc | null }) =>
        made.expiresAt === null || DateTime.toEpochMillis(made.expiresAt) > ends;

      // One that is asked to last for ever, or longer, lasts as long as its maker.
      for (const expiresInDays of [undefined, 3650]) {
        const made = yield* withIt.accounts.createOwnToken({
          payload: { name: "of a token", scopes: ["sessions:read"], expiresInDays },
        });
        expect(outlasts(made)).toBe(false);
      }
      // For another account as for its own.
      const bot = yield* withIt.accounts.create({ payload: { name: "Bot of a day" } });
      const theirs = yield* withIt.accounts.createToken({
        params: { id: bot.id },
        payload: { name: "of a token", scopes: ["sessions:read"] },
      });
      expect(outlasts(theirs)).toBe(false);
      // What does not run out makes what it is asked for, as before.
      const lasting = yield* kay.api.accounts.createOwnToken({
        payload: { name: "of one that lasts", scopes: ["sessions:read"] },
      });
      expect(lasting.expiresAt).toBeNull();
    }),
  );

  it.effect("an admin sees the tokens of an account, and takes one of them back", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const root = yield* Control.account("Root", true);
      const bot = yield* root.api.accounts.create({ payload: { name: "Bot" } });
      const whose = { id: bot.id };
      const made = yield* root.api.accounts.createToken({
        params: whose,
        payload: { name: "deploys", scopes: ["sessions:read"] },
      });
      const spare = yield* root.api.accounts.createToken({
        params: whose,
        payload: { name: "spare", scopes: ["sessions:read"], expiresInDays: 1 },
      });
      const listed = yield* root.api.accounts.tokensOf({ params: whose });
      expect(listed.map((token) => [token.name, token.accountId, token.revokedAt])).toEqual([
        ["deploys", bot.id, null],
        ["spare", bot.id, null],
      ]);
      expect(JSON.stringify(listed)).not.toContain(made.token);

      // Whoever is no admin does neither, and neither does an admin's token not made for it.
      const ada = yield* Control.account("Ada");
      expect((yield* Effect.flip(ada.api.accounts.tokensOf({ params: whose })))._tag).toBe(
        "Forbidden",
      );
      const lesser = yield* root.api.accounts.createOwnToken({
        payload: { name: "lesser", scopes: ["tokens:write"] },
      });
      const asLesser = yield* control.as(lesser.token);
      expect((yield* Effect.flip(asLesser.accounts.tokensOf({ params: whose })))._tag).toBe(
        "Forbidden",
      );
      expect(
        (yield* Effect.flip(
          asLesser.accounts.revokeTokenOf({ params: { ...whose, tokenId: made.id } }),
        ))._tag,
      ).toBe("Forbidden");

      // A token is taken back of the account it is of, and of no other.
      const elsewhere = yield* Effect.flip(
        root.api.accounts.revokeTokenOf({ params: { id: ada.account.id, tokenId: made.id } }),
      );
      expect(elsewhere._tag).toBe("ApiTokenNotFound");
      const nobody = "00000000-0000-7000-8000-000000000000";
      expect(
        (yield* Effect.flip(root.api.accounts.tokensOf({ params: { id: nobody } })))._tag,
      ).toBe("AccountNotFound");
      expect(
        (yield* Effect.flip(
          root.api.accounts.revokeTokenOf({ params: { id: nobody, tokenId: made.id } }),
        ))._tag,
      ).toBe("AccountNotFound");

      const withIt = yield* control.as(made.token);
      expect((yield* withIt.accounts.current()).name).toBe("Bot");
      yield* root.api.accounts.revokeTokenOf({ params: { ...whose, tokenId: made.id } });
      expect((yield* Effect.flip(withIt.accounts.current()))._tag).toBe("Unauthorized");
      const after = yield* root.api.accounts.tokensOf({ params: whose });
      expect(after.map((token) => [token.name, token.revokedAt !== null])).toEqual([
        ["deploys", true],
        ["spare", false],
      ]);
      expect((yield* (yield* control.as(spare.token)).accounts.current()).name).toBe("Bot");

      const { events } = yield* root.api.events.list({
        query: { resourceKind: "token", resourceId: made.id },
      });
      expect(events.map((event) => [event.kind, event.actor.id, event.resource?.label])).toEqual([
        ["token.revoked", root.account.id, "deploys"],
        ["token.created", root.account.id, "deploys"],
      ]);
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

  it.effect("an admin is told what each person signs in with", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const http = yield* HttpClient.HttpClient;
      const bootstrap = yield* control.as(control.bootstrapToken);
      const email = `wei@example.test`;
      const password = "a password of Wei's own";
      const wei = yield* bootstrap.accounts.create({ payload: { name: "Wei", email } });
      const told = (id: string) =>
        bootstrap.accounts
          .list()
          .pipe(Effect.map((all) => all.find((account) => account.id === id)?.signIn));
      const post = (path: string, body: object, cookie = "") =>
        http.execute(
          HttpClientRequest.post(`${control.url}/api/auth${path}`).pipe(
            HttpClientRequest.setHeader("origin", control.url),
            HttpClientRequest.setHeader("cookie", cookie),
            HttpClientRequest.bodyJsonUnsafe(body),
          ),
        );

      // Nobody is given a password: a person has one once they set it.
      const nothing = { password: false, secondFactor: false, passkeys: 0, providers: [] };
      expect(yield* told(wei.id)).toEqual(nothing);
      const { token } = yield* bootstrap.accounts.createSetupToken({ params: { id: wei.id } });
      yield* post("/reset-password", { token, newPassword: password });
      expect(yield* told(wei.id)).toEqual({ ...nothing, password: true });

      const cookie = cookiesOf(yield* post("/sign-in/email", { email, password }));
      const enabling = yield* post("/two-factor/enable", { password }, cookie);
      const { totpURI } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ totpURI: Schema.String }),
      )(yield* enabling.json);
      yield* post("/two-factor/verify-totp", { code: yield* totp(totpURI) }, cookie);
      expect(yield* told(wei.id)).toEqual({ ...nothing, password: true, secondFactor: true });

      // A service signs in with nothing.
      const bot = yield* Control.account(`Bot-of-no-ways`);
      expect(yield* told(bot.account.id)).toBeNull();
    }),
  );

  it.effect(
    "a disabled account signs in nowhere and is nobody's caller, until it is enabled again",
    () =>
      Effect.gen(function* () {
        const control = yield* Control.Control;
        const http = yield* HttpClient.HttpClient;
        const bootstrap = yield* control.as(control.bootstrapToken);
        const mira = yield* signedIn(`Mira-disabled`, `mira-off@example.test`);
        const at = { params: { id: mira.account.id } };
        const held = yield* bootstrap.accounts.createToken({
          ...at,
          payload: { name: "held", scopes: Control.ALL_SCOPES },
        });
        const withToken = yield* control.as(held.token);
        const root = yield* Control.account(`Root-disabling`, true);
        const other = yield* Control.account(`Other-disabling`);
        const account = (cookie: string) =>
          http
            .execute(
              HttpClientRequest.get(`${control.url}/api/control/account`).pipe(
                HttpClientRequest.setHeader("cookie", cookie),
              ),
            )
            .pipe(Effect.map((answer) => answer.status));
        const signIn = http.execute(
          HttpClientRequest.post(`${control.url}/api/auth/sign-in/email`).pipe(
            HttpClientRequest.setHeader("origin", control.url),
            HttpClientRequest.bodyJsonUnsafe({ email: mira.email, password: mira.password }),
          ),
        );
        expect(yield* account(mira.cookie)).toBe(200);

        // An admin's to do, and of nobody's own account.
        expect((yield* Effect.flip(other.api.accounts.disable(at)))._tag).toBe("Forbidden");
        expect(
          (yield* Effect.flip(root.api.accounts.disable({ params: { id: root.account.id } })))._tag,
        ).toBe("Forbidden");

        const disabled = yield* root.api.accounts.disable(at);
        expect(disabled.disabledAt).not.toBeNull();
        // At once: the cookies they had, their tokens, and what they prove themselves by.
        expect(yield* account(mira.cookie)).toBe(401);
        expect((yield* Effect.flip(withToken.accounts.current()))._tag).toBe("Unauthorized");
        const refused = yield* signIn;
        expect([refused.status, yield* refused.json]).toMatchObject([
          403,
          { code: "account_disabled" },
        ]);
        expect(yield* account(cookiesOf(refused))).toBe(401);
        // The account stays, with all that is its own, and since when it was disabled.
        const again = yield* root.api.accounts.disable(at);
        expect(again.disabledAt?.pipe(DateTime.toEpochMillis)).toBe(
          disabled.disabledAt?.pipe(DateTime.toEpochMillis),
        );
        expect(
          (yield* root.api.accounts.list()).find((listed) => listed.id === mira.account.id),
        ).toMatchObject({ name: mira.account.name, signIn: { password: true } });

        const enabled = yield* root.api.accounts.enable(at);
        expect(enabled.disabledAt).toBeNull();
        expect((yield* withToken.accounts.current()).id).toBe(mira.account.id);
        // Whoever was signed out by it signs in again.
        expect(yield* account(mira.cookie)).toBe(401);
        expect(yield* account(cookiesOf(yield* signIn))).toBe(200);
        expect(
          (yield* Effect.flip(
            root.api.accounts.enable({ params: { id: "00000000-0000-7000-8000-00000000dead" } }),
          ))._tag,
        ).toBe("AccountNotFound");
      }),
  );

  it.effect("an account is removed with its person, its tokens and its places in workspaces", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const http = yield* HttpClient.HttpClient;
      const bootstrap = yield* control.as(control.bootstrapToken);
      const email = `gil@example.test`;
      const gil = yield* signedIn(`Gil`, email);
      const at = { params: { id: gil.account.id } };
      const held = yield* bootstrap.accounts.createToken({
        ...at,
        payload: { name: "held", scopes: Control.ALL_SCOPES },
      });
      const withToken = yield* control.as(held.token);
      const root = yield* Control.account(`Root-removing`, true);
      const other = yield* Control.account(`Other-removing`);
      const workspace = yield* root.api.workspaces.create({ payload: { name: "Gil's team" } });
      yield* root.api.workspaces.admit({
        params: { id: workspace.id, accountId: gil.account.id },
        payload: { role: "member" },
      });

      expect((yield* Effect.flip(other.api.accounts.remove(at)))._tag).toBe("Forbidden");
      expect(
        (yield* Effect.flip(root.api.accounts.remove({ params: { id: root.account.id } })))._tag,
      ).toBe("Forbidden");
      yield* root.api.accounts.remove(at);

      expect(
        (yield* root.api.accounts.list()).filter((listed) => listed.id === gil.account.id),
      ).toEqual([]);
      expect((yield* Effect.flip(withToken.accounts.current()))._tag).toBe("Unauthorized");
      expect(
        (yield* root.api.workspaces.members({ params: { id: workspace.id } })).map(
          (member) => member.accountId,
        ),
      ).not.toContain(gil.account.id);
      const cookied = yield* http.execute(
        HttpClientRequest.get(`${control.url}/api/control/account`).pipe(
          HttpClientRequest.setHeader("cookie", gil.cookie),
        ),
      );
      expect(cookied.status).toBe(401);
      const signing = yield* http.execute(
        HttpClientRequest.post(`${control.url}/api/auth/sign-in/email`).pipe(
          HttpClientRequest.setHeader("origin", control.url),
          HttpClientRequest.bodyJsonUnsafe({ email, password: gil.password }),
        ),
      );
      expect(signing.status).toBe(401);
      expect((yield* Effect.flip(root.api.accounts.remove(at)))._tag).toBe("AccountNotFound");
      // Their address is anyone's again.
      yield* bootstrap.accounts.create({ payload: { name: "Gil again", email } });
    }),
  );

  it.effect(
    "what is removed is kept in the database and found by nothing, and what it had is another's",
    () =>
      Effect.gen(function* () {
        const control = yield* Control.Control;
        const http = yield* HttpClient.HttpClient;
        const { sql } = control;
        const bootstrap = yield* control.as(control.bootstrapToken);
        const email = "hal@example.test";
        const hal = yield* signedIn("Hal", email);
        const at = { params: { id: hal.account.id } };
        const held = yield* bootstrap.accounts.createToken({
          ...at,
          payload: { name: "held", scopes: Control.ALL_SCOPES },
        });
        const root = yield* Control.account("Root-keeping", true);
        const team = yield* root.api.workspaces.create({ payload: { name: "Hal's team" } });
        const seat = { params: { id: team.id, accountId: hal.account.id } };
        yield* root.api.workspaces.admit({ ...seat, payload: { role: "member" } });
        // Put out and let in again: the pair is nobody's while nobody has it.
        yield* root.api.workspaces.dismiss(seat);
        yield* root.api.workspaces.admit({ ...seat, payload: { role: "admin" } });
        expect(
          yield* sql`
            SELECT role, deleted_at IS NULL AS live FROM workspace_members
            WHERE account_id = ${hal.account.id} ORDER BY deleted_at NULLS LAST
          `,
        ).toEqual([
          { role: "member", live: false },
          { role: "admin", live: true },
        ]);

        yield* root.api.accounts.remove(at);
        // All of it is there still, and says since when it is not.
        for (const kept of [
          sql`SELECT deleted_at FROM accounts WHERE id = ${hal.account.id}`,
          sql`SELECT deleted_at FROM api_tokens WHERE id = ${held.id}`,
          sql`SELECT deleted_at FROM workspace_members WHERE account_id = ${hal.account.id}`,
        ]) {
          const rows = yield* kept;
          expect(rows.length).toBeGreaterThan(0);
          expect(rows.every((row) => row["deleted_at"] !== null)).toBe(true);
        }
        // What they signed in with is not: nobody is that person again.
        expect(yield* sql`SELECT id FROM "user" WHERE email = ${email}`).toEqual([]);
        expect((yield* Effect.flip(root.api.accounts.get(at)))._tag).toBe("AccountNotFound");
        expect((yield* Effect.flip(root.api.accounts.tokensOf(at)))._tag).toBe("AccountNotFound");
        expect(
          (yield* Effect.flip(
            root.api.workspaces.ofAccount({ params: { accountId: hal.account.id } }),
          ))._tag,
        ).toBe("AccountNotFound");
        expect((yield* Effect.flip(bootstrap.accounts.lookup({ query: { email } })))._tag).toBe(
          "PersonNotFound",
        );
        expect((yield* Effect.flip((yield* control.as(held.token)).accounts.current()))._tag).toBe(
          "Unauthorized",
        );
        expect(yield* root.api.workspaces.members({ params: { id: team.id } })).toEqual([
          expect.objectContaining({ accountId: root.account.id }),
        ]);

        // Someone else is made with the address, signs in with it, and is nobody they were.
        const again = yield* signedIn("Hal again", email);
        expect(again.account.id).not.toBe(hal.account.id);
        const whose = (cookie: string) =>
          http.execute(
            HttpClientRequest.get(`${control.url}/api/control/account`).pipe(
              HttpClientRequest.setHeader("cookie", cookie),
            ),
          );
        expect(yield* (yield* whose(again.cookie)).json).toMatchObject({ id: again.account.id });
        expect((yield* whose(hal.cookie)).status).toBe(401);
        expect(
          (yield* bootstrap.accounts.list())
            .filter((one) => one.email === email)
            .map((one) => one.id),
        ).toEqual([again.account.id]);

        // A workspace that is deleted is kept likewise, with who was in it.
        yield* root.api.workspaces.delete({ params: { id: team.id } });
        expect((yield* root.api.workspaces.list()).map((one) => one.id)).not.toContain(team.id);
        expect(
          (yield* Effect.flip(root.api.workspaces.members({ params: { id: team.id } })))._tag,
        ).toBe("WorkspaceNotFound");
        expect(
          (yield* Effect.flip(
            root.api.workspaces.rename({ params: { id: team.id }, payload: { name: "Back" } }),
          ))._tag,
        ).toBe("WorkspaceNotFound");
        expect(
          yield* sql`
            SELECT name, deleted_at IS NULL AS live FROM workspaces WHERE id = ${team.id}
          `,
        ).toEqual([{ name: "Hal's team", live: false }]);
        expect(
          yield* sql`
            SELECT 1 FROM workspace_members WHERE workspace_id = ${team.id} AND deleted_at IS NULL
          `,
        ).toEqual([]);
      }),
  );

  it.effect(
    "whoever says who is in a workspace finds a person by their whole address, and nobody else does",
    () =>
      Effect.gen(function* () {
        const control = yield* Control.Control;
        const bootstrap = yield* control.as(control.bootstrapToken);
        const email = `ida@example.test`;
        const ida = yield* bootstrap.accounts.create({ payload: { name: "Ida", email } });
        const lea = yield* Control.account(`Lea`);
        const asked = { query: { email } };

        // In no workspace, and an admin of none.
        expect((yield* Effect.flip(lea.api.accounts.lookup(asked)))._tag).toBe("Forbidden");
        const team = yield* lea.api.workspaces.create({ payload: { name: "Lea's team" } });
        const asLea = yield* control.as(lea.token);
        expect(yield* asLea.accounts.lookup(asked)).toEqual({
          id: ida.id,
          name: "Ida",
          email,
        });
        expect(
          (yield* asLea.accounts.lookup({ query: { email: ` ${email.toUpperCase()} ` } })).id,
        ).toBe(ida.id);

        // A part of an address finds nobody, and neither does what is no address of anyone.
        for (const part of ["ida", `ida@`, "@example.test", "%", lea.account.name]) {
          const none = yield* Effect.flip(asLea.accounts.lookup({ query: { email: part } }));
          expect(none._tag).toBe("PersonNotFound");
        }
        const empty = yield* control.request(lea.token, "GET", "/api/control/accounts/lookup");
        expect(empty.status).toBe(400);

        // A member who is no admin of the workspace, and a token that is not for workspaces.
        const mia = yield* Control.account(`Mia`);
        yield* asLea.workspaces.admit({
          params: { id: team.id, accountId: mia.account.id },
          payload: { role: "member" },
        });
        const asMia = yield* control.as(mia.token);
        expect((yield* Effect.flip(asMia.accounts.lookup(asked)))._tag).toBe("Forbidden");
        const reader = yield* asLea.accounts.createOwnToken({
          payload: { name: "reader", scopes: ["tokens:write", "sessions:write"] },
        });
        const asReader = yield* control.as(reader.token);
        expect((yield* Effect.flip(asReader.accounts.lookup(asked)))._tag).toBe("Forbidden");

        // Who is in the workspace is told with what they sign in with.
        yield* asLea.workspaces.admit({
          params: { id: team.id, accountId: ida.id },
          payload: { role: "member" },
        });
        expect(yield* asMia.workspaces.members({ params: { id: team.id } })).toEqual([
          { accountId: ida.id, name: "Ida", kind: "person", email, role: "member" },
          {
            accountId: lea.account.id,
            name: lea.account.name,
            kind: "service",
            email: null,
            role: "admin",
          },
          {
            accountId: mia.account.id,
            name: mia.account.name,
            kind: "service",
            email: null,
            role: "member",
          },
        ]);

        // An account that is disabled is found by nobody.
        yield* bootstrap.accounts.disable({ params: { id: ida.id } });
        expect((yield* Effect.flip(asLea.accounts.lookup(asked)))._tag).toBe("PersonNotFound");
        expect((yield* Effect.flip(bootstrap.accounts.lookup(asked)))._tag).toBe("PersonNotFound");
        yield* bootstrap.accounts.enable({ params: { id: ida.id } });
        expect((yield* bootstrap.accounts.lookup(asked)).id).toBe(ida.id);
      }),
  );

  it.effect(
    "an admin is told which workspaces an account is in, and puts it in and out by its id",
    () =>
      Effect.gen(function* () {
        const control = yield* Control.Control;
        const bootstrap = yield* control.as(control.bootstrapToken);
        const root = yield* Control.account(`Root-places`, true);
        const owner = yield* Control.account(`Owner-places`);
        // A service account has no address to be found by: it is named by its id.
        const robot = yield* bootstrap.accounts.create({
          payload: { name: `Robot`, kind: "service" },
        });
        const person = yield* bootstrap.accounts.create({
          payload: { name: "Noa", email: `noa@example.test` },
        });
        const first = yield* owner.api.workspaces.create({ payload: { name: "First places" } });
        const second = yield* owner.api.workspaces.create({ payload: { name: "Second places" } });
        const places = (accountId: string) =>
          Effect.map(root.api.workspaces.ofAccount({ params: { accountId } }), (all) =>
            all.map((one) => [one.name, one.role]),
          );

        expect(yield* places(robot.id)).toEqual([]);
        // An admin who is in neither workspace says who is in them.
        yield* root.api.workspaces.admit({
          params: { id: first.id, accountId: robot.id },
          payload: { role: "member" },
        });
        yield* root.api.workspaces.admit({
          params: { id: second.id, accountId: robot.id },
          payload: { role: "admin" },
        });
        yield* root.api.workspaces.admit({
          params: { id: second.id, accountId: person.id },
          payload: { role: "member" },
        });
        expect(yield* places(robot.id)).toEqual([
          ["First places", "member"],
          ["Second places", "admin"],
        ]);
        expect(yield* places(person.id)).toEqual([["Second places", "member"]]);
        expect(yield* places(owner.account.id)).toEqual([
          ["First places", "admin"],
          ["Second places", "admin"],
        ]);
        // What it does there is changed by admitting it again, and it is put out.
        yield* root.api.workspaces.admit({
          params: { id: first.id, accountId: robot.id },
          payload: { role: "admin" },
        });
        yield* root.api.workspaces.dismiss({ params: { id: second.id, accountId: robot.id } });
        expect(yield* places(robot.id)).toEqual([["First places", "admin"]]);
        // Each is written down as any change of who is in a workspace.
        const written = (yield* bootstrap.events.list({ query: { workspaceId: first.id } })).events;
        expect(
          written
            .filter((event) => event.kind === "workspace.member_admitted")
            .map((event) => [event.actor.name, event.detail]),
        ).toEqual([
          [root.account.name, { accountId: robot.id, account: robot.name, role: "admin" }],
          [root.account.name, { accountId: robot.id, account: robot.name, role: "member" }],
        ]);

        // Nobody but an admin is told: not the account itself, nor an admin of the workspace.
        const asRobot = yield* control.as(
          (yield* bootstrap.accounts.createToken({
            params: { id: robot.id },
            payload: { name: "checks", scopes: Control.ALL_SCOPES },
          })).token,
        );
        for (const asked of [asRobot, owner.api]) {
          expect(
            (yield* Effect.flip(asked.workspaces.ofAccount({ params: { accountId: robot.id } })))
              ._tag,
          ).toBe("Forbidden");
        }
        // An admin's token that is not for an admin's doings is told nothing either.
        const reader = yield* root.api.accounts.createOwnToken({
          payload: { name: "reader", scopes: ["workspaces:write", "tokens:write"] },
        });
        expect(
          (yield* Effect.flip(
            (yield* control.as(reader.token)).workspaces.ofAccount({
              params: { accountId: robot.id },
            }),
          ))._tag,
        ).toBe("Forbidden");
        expect(
          (yield* Effect.flip(
            root.api.workspaces.ofAccount({
              params: { accountId: "00000000-0000-7000-8000-000000000000" },
            }),
          ))._tag,
        ).toBe("AccountNotFound");
        // What a workspace's admin may do is what it was: they name whom they let in.
        yield* owner.api.workspaces.admit({
          params: { id: second.id, accountId: robot.id },
          payload: { role: "member" },
        });
        expect((yield* places(robot.id)).length).toBe(2);
      }),
  );

  it.effect("the last admin is neither disabled nor removed", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const bootstrap = yield* control.as(control.bootstrapToken);
      const last = yield* Control.account(`Last-admin`, true);
      const at = { params: { id: last.account.id } };
      const others = (yield* bootstrap.accounts.list()).filter(
        (account) => account.admin && account.disabledAt === null && account.id !== at.params.id,
      );
      yield* Effect.forEach(others, (account) =>
        bootstrap.accounts.disable({ params: { id: account.id } }),
      );
      expect((yield* Effect.flip(bootstrap.accounts.disable(at)))._tag).toBe("AccountInUse");
      expect((yield* Effect.flip(bootstrap.accounts.remove(at)))._tag).toBe("AccountInUse");
      yield* Effect.forEach(others, (account) =>
        bootstrap.accounts.enable({ params: { id: account.id } }),
      );
      // With another admin beside it, it is as any account.
      yield* bootstrap.accounts.remove(at);
    }),
  );

  it.effect("a path that names something by what is no id of one is refused", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const asked = [
        ["POST", "/api/control/accounts/nope/disable"],
        ["POST", "/api/control/accounts/nope/enable"],
        ["DELETE", "/api/control/accounts/nope"],
        ["POST", "/api/control/accounts/nope/tokens"],
        ["DELETE", "/api/control/account/tokens/nope"],
        ["GET", "/api/control/workspaces/nope/members"],
        ["GET", "/api/control/accounts/nope/workspaces"],
        ["DELETE", "/api/control/workspaces/nope"],
        ["DELETE", "/api/control/oauth/grants/nope"],
      ] as const;
      for (const [method, path] of asked) {
        const answer = yield* control.request(control.bootstrapToken, method, path, {
          name: "checks",
          scopes: ["admin"],
        });
        expect([method, path, answer.status]).toEqual([method, path, 400]);
      }
      // An id that is one, of nothing, is not found as before.
      const none = yield* control.request(
        control.bootstrapToken,
        "POST",
        "/api/control/accounts/00000000-0000-7000-8000-000000000000/disable",
      );
      expect(none.status).toBe(404);
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
          "/api/control/sessions/{id}/file-links",
          "/api/control/accounts/{id}",
          "/api/control/health",
        ]),
      );
    }),
  );

  it.effect("anyone is told that it serves, and nothing else", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const http = yield* HttpClient.HttpClient;
      const answer = yield* http.get(`${control.url}/api/control/health`);
      expect(answer.status).toBe(200);
      expect(yield* answer.json).toEqual({ status: "ok" });
    }),
  );
});
