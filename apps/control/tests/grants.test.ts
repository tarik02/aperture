import type { Caller } from "@aperture-browser/control-api";
import { suite } from "@aperture-browser/e2e/src/suite.ts";
import { expect } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { Events } from "../src/events/service.ts";
import * as Forgetting from "../src/grants/forgetting.ts";
import * as GrantsLive from "../src/grants/layer.ts";
import { Grants } from "../src/grants/service.ts";
import * as Stores from "./src/stores.ts";

const REDIRECT = "http://127.0.0.1:9/callback";
const ADA = "00000000-0000-7000-8000-000000000001";

const ada: Caller = {
  account: Option.some({
    id: ADA,
    name: "Ada",
    admin: false,
    kind: "person",
    email: "ada@example.test",
    createdAt: DateTime.makeUnsafe(0),
    disabledAt: null,
  }),
  admin: false,
  scopes: null,
  resources: null,
  workspaces: [],
};

const registered = (name: string) =>
  Grants.use((grants) => grants.register({ name, redirectUris: [REDIRECT] }));

/** Whether the app is still one that may ask a person for a grant. */
const known = (clientId: string) =>
  Grants.use((grants) => grants.asking({ clientId, redirectUri: REDIRECT })).pipe(
    Effect.as(true),
    Effect.catchTag("OAuthClientNotFound", () => Effect.succeed(false)),
  );

/** An app nobody gave a grant, and one whose grant the person took back. */
const apps = Effect.gen(function* () {
  const grants = yield* Grants;
  const ungranted = yield* registered("Never granted");
  const granted = yield* registered("Granted once");
  yield* grants.approve(ada, {
    clientId: granted.id,
    redirectUri: REDIRECT,
    codeChallenge: "a challenge",
    scopes: ["sessions:read"],
    resources: undefined,
  });
  const [grant] = yield* grants.list(ada);
  yield* grants.revoke(ada, grant?.id ?? "");
  expect(yield* grants.list(ada)).toEqual([]);
  return { ungranted: ungranted.id, granted: granted.id };
});

/** What was recorded of grants that were taken, by the grant's id: by whose doing. */
const taken = new Map<string, unknown>();
const events = Layer.succeed(
  Events,
  Events.of({
    record: (event) =>
      Effect.sync(() => {
        if (event.kind === "grant.revoked" && event.resource) {
          taken.set(event.resource.id, event.detail?.["by"]);
        }
      }),
    list: () => Effect.succeed({ events: [], next: null }),
    forget: () => Effect.void,
  }),
);

const VERIFIER = "a-verifier-the-app-made-and-keeps-to-itself-0123456789";

/** A grant of Ada's to a new app, and the tokens the app got for its code. */
const granted = Effect.fn(function* (name: string) {
  const grants = yield* Grants;
  const app = yield* registered(name);
  const digest = yield* Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(VERIFIER)),
  );
  const code = yield* grants.approve(ada, {
    clientId: app.id,
    redirectUri: REDIRECT,
    codeChallenge: Base64Url.encode(new Uint8Array(digest)),
    scopes: ["sessions:read"],
    resources: undefined,
  });
  const tokens = yield* grants.exchange({
    clientId: app.id,
    redirectUri: REDIRECT,
    code,
    codeVerifier: VERIFIER,
  });
  const grant = (yield* grants.list(ada)).find((one) => one.clientId === app.id);
  return { clientId: app.id, id: grant?.id ?? "", tokens };
});

/**
 * A refresh token that comes a second time: at once it is refused and nothing else, and
 * once `later` has let more than the grace go by it ends the grant.
 */
const reused = <E, R>(later: Effect.Effect<unknown, E, R>) =>
  Effect.gen(function* () {
    const grants = yield* Grants;
    const { clientId, id, tokens } = yield* granted("Refreshes twice");
    const refresh = (refreshToken: string) => grants.refresh({ clientId, refreshToken });
    const listed = Effect.map(grants.list(ada), (all) => all.map((grant) => grant.id));

    const next = yield* refresh(tokens.refreshToken);
    // Two processes of one app that refresh at once: the second gets nothing, and the
    // first goes on with what it got.
    expect((yield* Effect.flip(refresh(tokens.refreshToken)))._tag).toBe("GrantRefused");
    expect(yield* listed).toContain(id);
    expect(taken.has(id)).toBe(false);
    const after = yield* refresh(next.refreshToken);

    yield* later;
    expect((yield* Effect.flip(refresh(tokens.refreshToken)))._tag).toBe("GrantRefused");
    expect(yield* listed).not.toContain(id);
    expect(taken.get(id)).toBe("token_reused");
    // Whoever has the newest tokens has nothing either: the person is asked again.
    expect((yield* Effect.flip(refresh(after.refreshToken)))._tag).toBe("GrantRefused");
    expect((yield* Effect.flip(grants.revoke(ada, id)))._tag).toBe("GrantNotFound");
  });

const needs = GrantsLive.layer.pipe(
  Layer.provide(events),
  Layer.provideMerge(
    Layer.effectDiscard(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO accounts (id, name, admin, created_at)
          VALUES (${ADA}, 'Ada', false, ${new Date(0)})`;
      }),
    ),
  ),
  Layer.provideMerge(Stores.layer()),
);

suite(needs)("what apps left", (it) => {
  it.effect("an app nobody gave a grant is forgotten a day after it registered", () =>
    Effect.gen(function* () {
      const { ungranted, granted } = yield* apps;
      yield* Stores.hours(23);
      expect(yield* known(ungranted)).toBe(true);
      const late = yield* registered("Registered later");

      yield* Stores.hours(2);
      expect(yield* known(ungranted)).toBe(false);
      // One that was given a grant asks again as what it registered as, whenever.
      expect(yield* known(granted)).toBe(true);
      expect(yield* known(late.id)).toBe(true);
    }).pipe(Effect.provide(Stores.forgetting(Grants, Forgetting.layer))),
  );

  it.effect("a refresh token that comes again after a while ends its grant", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* reused(TestClock.adjust("61 seconds"));
      // What was spent goes with what ran out.
      const grants = yield* Grants;
      const { tokens, clientId } = yield* granted("Refreshes on");
      yield* grants.refresh({ clientId, refreshToken: tokens.refreshToken });
      const spent = sql`SELECT 1 FROM oauth_tokens WHERE spent_at IS NOT NULL`;
      expect(yield* spent).toHaveLength(1);
      yield* grants.forget();
      expect(yield* spent).toHaveLength(1);
      yield* TestClock.adjust("61 days");
      yield* grants.forget();
      expect(yield* spent).toHaveLength(0);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("grants given to one app at once leave one, and none of them fails", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const grants = yield* Grants;
      const app = yield* registered("Asked for twice");
      const codes = yield* Effect.forEach(
        Array.from({ length: 8 }),
        () =>
          grants.approve(ada, {
            clientId: app.id,
            redirectUri: REDIRECT,
            codeChallenge: "a challenge",
            scopes: ["sessions:read"],
            resources: undefined,
          }),
        { concurrency: "unbounded" },
      );
      expect(new Set(codes).size).toBe(8);
      const left = (yield* grants.list(ada)).filter((grant) => grant.clientId === app.id);
      expect(left).toHaveLength(1);
      // The code of the grant that is left is the only one there still is.
      expect(
        yield* sql`SELECT 1 FROM oauth_codes
          JOIN oauth_grants ON oauth_grants.id = oauth_codes.grant_id
          WHERE oauth_grants.client_id = ${app.id}`,
      ).toHaveLength(1);
      // The database itself keeps a second of the pair out.
      const second = yield* Effect.flip(sql`
        INSERT INTO oauth_grants (id, account_id, client_id, scopes, created_at)
        SELECT gen_random_uuid(), account_id, client_id, scopes, created_at
        FROM oauth_grants WHERE id = ${left[0]?.id ?? ""}
      `);
      expect(second._tag).toBe("SqlError");
    }),
  );
});
