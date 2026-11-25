import * as Control from "@aperture-browser/control/tests/src/control.ts";
import { cookiesOf } from "@aperture-browser/control/tests/src/person.ts";
import { totp } from "@aperture-browser/control/tests/src/totp.ts";
import {
  V1_PASSWORD,
  V1_PASSWORD_DIGEST,
  V1_SECOND_FACTOR,
  V1_TOKEN_DIGEST,
  V1_TOKEN_SECRET,
} from "@aperture-browser/control/tests/src/v1.ts";
import { Executor } from "@aperture-browser/e2e/src/executor.ts";
import { suite } from "@aperture-browser/e2e/src/suite.ts";
import { expect } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as App from "../src/app.ts";
import { Migrator, type MigratorShape } from "../src/migrator/service.ts";
import * as Fixture from "./src/fixture.ts";
import * as Node from "./src/node.ts";

/** Alice signs in with a password alone, Bob with a password and a code. */
const ALICE = "alice@example.com";
const BOB = "bob@example.com";
/** The token whose secret is known; the others' are not, and are kept all the same. */
const CI = "ci";
const TOKENS = 5;

const needs = Fixture.layerWith({
  passwords: { [ALICE]: V1_PASSWORD_DIGEST, [BOB]: V1_PASSWORD_DIGEST },
  secondFactors: { [BOB]: V1_SECOND_FACTOR },
  tokens: { [CI]: V1_TOKEN_DIGEST },
}).pipe(Layer.provideMerge(Node.registered), Layer.provideMerge(Control.layer()));

const Counted = Schema.Array(Schema.Struct({ count: Schema.Number }));

suite(needs)("v1's passwords, second factors and tokens, moved as they were", (it) => {
  const migrating = <A, E>(run: (migrator: MigratorShape) => Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const v1 = yield* Fixture.V1;
      const executor = yield* Executor;
      return yield* Migrator.use(run).pipe(
        Effect.provide(
          App.layer({
            v1Database: v1.database,
            v1ColdRoot: Option.none(),
            v1StoreRoot: Option.none(),
            node: Option.some(Node.NODE),
            nodeStore: Option.some(executor.data),
            tokens: "keep",
            secretsFile: Option.none(),
            sessions: "drop",
          }).pipe(
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(control.settings))),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, "Warn")),
          ),
        ),
      );
    });

  const post = (path: string, body: object, cookie = "") =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const http = yield* HttpClient.HttpClient;
      return yield* http.execute(
        HttpClientRequest.post(`${control.url}/api/auth${path}`).pipe(
          HttpClientRequest.setHeader("origin", control.url),
          HttpClientRequest.setHeader("cookie", cookie),
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
      );
    });

  const left = (table: string) =>
    Effect.gen(function* () {
      const { sql } = yield* Control.Control;
      const [row] = yield* sql`SELECT count(*)::int AS count FROM ${sql(table)}`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Counted)),
      );
      return row?.count;
    });

  it.effect("they are kept with no file for secrets, and the plan says so", () =>
    Effect.gen(function* () {
      const planned = yield* migrating((migrator) => migrator.plan());
      expect(planned.conflicts).toEqual([]);
      const people = planned.steps.flatMap((step) => (step.kind === "person" ? [step] : []));
      expect(
        people.map((person) => [person.email, person.password !== null, person.secondFactor]),
      ).toEqual([
        [ALICE, true, null],
        [BOB, true, V1_SECOND_FACTOR],
        ["carol@example.com", false, null],
      ]);
      const tokens = planned.steps.flatMap((step) => (step.kind === "token" ? [step] : []));
      expect(tokens.length).toBe(TOKENS);
      expect(tokens.every((token) => token.digest?.startsWith("$2a$10$"))).toBe(true);
      yield* migrating((migrator) => migrator.apply());
      expect(yield* left("v1_api_tokens")).toBe(TOKENS);
    }),
  );

  it.effect("a token of v1 works as it did, and from its first use is v2's own", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const v1 = yield* Fixture.V1;
      const ci = yield* Effect.fromNullishOr(v1.rows.api_tokens.find((row) => row.name === CI));
      const bearer = `apt_${ci.id}_${V1_TOKEN_SECRET}`;
      const refused = yield* control.request(`${bearer}x`, "GET", "/api/control/account");
      expect(refused.status).toBe(401);
      const held = yield* control.as(bearer);
      expect(yield* held.accounts.current()).toMatchObject({
        name: "Team tokens (from v1)",
        scopes: ["sessions:write", "snapshots:read", "workspaces:write", "tokens:write"],
      });
      expect(yield* left("v1_api_tokens")).toBe(TOKENS - 1);
      expect((yield* held.snapshots.list({ query: {} })).length).toBe(1);
    }),
  );

  it.effect("a person signs in with their password of v1, and their second factor", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const bootstrap = yield* control.as(control.bootstrapToken);
      const told = (yield* bootstrap.accounts.list()).filter(
        (account) => account.kind === "person",
      );
      expect(
        told
          .map((account) => [account.email, account.signIn?.password, account.signIn?.secondFactor])
          .toSorted(([one], [other]) => String(one).localeCompare(String(other))),
      ).toEqual([
        [ALICE, true, false],
        [BOB, true, true],
        ["carol@example.com", false, false],
      ]);

      expect((yield* post("/sign-in/email", { email: ALICE, password: "not hers" })).status).toBe(
        401,
      );
      const alice = yield* post("/sign-in/email", { email: ALICE, password: V1_PASSWORD });
      expect(alice.status).toBe(200);
      expect(yield* alice.json).not.toMatchObject({ twoFactorRedirect: true });

      const half = yield* post("/sign-in/email", { email: BOB, password: V1_PASSWORD });
      expect(yield* half.json).toMatchObject({ twoFactorRedirect: true });
      // An authenticator set up in v1 shows the codes v2 takes.
      const code = yield* totp(`otpauth://totp/Aperture:bob?secret=${V1_SECOND_FACTOR}`);
      const bob = yield* post("/two-factor/verify-totp", { code }, cookiesOf(half));
      expect(bob.status).toBe(200);
      // Each password is v2's own once it was used.
      const { sql } = control;
      expect(
        yield* sql`SELECT count(*)::int AS count FROM account WHERE password LIKE ${"$argon2id$%"}`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Counted)),
        ),
      ).toEqual([{ count: 0 }]);
      expect((yield* post("/sign-in/email", { email: ALICE, password: V1_PASSWORD })).status).toBe(
        200,
      );
    }),
  );
});
