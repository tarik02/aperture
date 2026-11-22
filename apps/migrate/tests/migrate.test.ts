import { PREFIX } from "@aperture-browser/control-api";
import * as Control from "@aperture-browser/control/tests/src/control.ts";
import { Executor } from "@aperture-browser/e2e/src/executor.ts";
import { directory } from "@aperture-browser/e2e/src/process.ts";
import * as Site from "@aperture-browser/e2e/src/site.ts";
import { suite } from "@aperture-browser/e2e/src/suite.ts";
import { until } from "@aperture-browser/e2e/src/wait.ts";
import { expect } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as App from "../src/app.ts";
import { Migrator, type MigratorShape } from "../src/migrator/service.ts";
import { nodeId } from "../src/plan.ts";
import { Line } from "../src/secrets/file.ts";
import * as Fixture from "./src/fixture.ts";
import * as Node from "./src/node.ts";

/** The site the browser v1 took a snapshot of was signed in to, as the recording served it. */
class Signed extends Context.Service<Signed, Site.Site>()(
  "@aperture-browser/migrate/tests/Signed",
) {}

const site = Layer.effect(
  Signed,
  Site.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const signedIn = (request.headers["cookie"] ?? "").includes("sid=alice-secret");
      return yield* Site.html(`<title>${signedIn ? "signed in as alice" : "signed out"}</title>`);
    }),
  ),
);

/** A directory for what the checks have the migrator write, as long as the suite. */
class Scratch extends Context.Service<Scratch, string>()(
  "@aperture-browser/migrate/tests/Scratch",
) {}

const needs = Layer.mergeAll(Fixture.layer, site, Layer.effect(Scratch, directory)).pipe(
  Layer.provideMerge(Node.registered),
  Layer.provideMerge(Control.layer()),
);

/** What the fixture's v1 has, as `fixture/record.sh` made it. */
const TEAM = "Team";
const SNAPSHOT = "signed-in";
/** Three people, two workspaces, three service accounts, four members, a snapshot, four tokens. */
const STEPS = 17;

const Created = Schema.Struct({ targetId: Schema.String });

/** A snapshot as the control plane tells it, of which this is what the checks read. */
const Told = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    name: Schema.NullOr(Schema.String),
    description: Schema.NullOr(Schema.String),
    tags: Schema.Record(Schema.String, Schema.String),
    workspaceId: Schema.NullOr(Schema.String),
    shared: Schema.Boolean,
  }),
);
const Lines = Schema.Array(Line);

suite(needs)("a v1 installation moved into v2", (it) => {
  /** A run of the migrator beside the control plane, as a program of its own is one. */
  const migrating = <A, E>(
    said: Partial<App.Asked>,
    run: (migrator: MigratorShape) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const v1 = yield* Fixture.V1;
      const executor = yield* Executor;
      const asked: App.Asked = {
        v1Database: v1.database,
        v1ColdRoot: Option.none(),
        node: Option.some(Node.NODE),
        nodeStore: Option.some(executor.data),
        tokens: "reissue",
        secretsFile: Option.some(`${yield* Scratch}/secrets.jsonl`),
        sessions: "drop",
        ...said,
      };
      return yield* Migrator.use(run).pipe(
        Effect.provide(
          App.layer(asked).pipe(
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(control.settings))),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, "Warn")),
          ),
        ),
      );
    });

  const secrets = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const written = yield* fs.readFileString(`${yield* Scratch}/secrets.jsonl`);
    return yield* Schema.decodeUnknownEffect(Lines)(written.trim().split("\n"));
  });

  const secretOf = (name: string) =>
    secrets.pipe(
      Effect.flatMap((lines) => Effect.fromNullishOr(lines.find((line) => line.name === name))),
      Effect.map((line) => line.secret),
    );

  const admin = Effect.gen(function* () {
    const control = yield* Control.Control;
    return yield* control.as(control.bootstrapToken);
  });

  /** The snapshots whoever holds the token is told of. */
  const snapshotsOf = (token: string) =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const answer = yield* control.request(token, "GET", `${PREFIX}/snapshots`);
      return yield* Schema.decodeUnknownEffect(Told)(answer.body);
    });

  const allSnapshots = Effect.gen(function* () {
    return yield* snapshotsOf((yield* Control.Control).bootstrapToken);
  });

  let before = "";
  let events = 0;

  it.effect("with nothing said, the plan tells what is in the way and moves nothing", () =>
    Effect.gen(function* () {
      const v1 = yield* Fixture.V1;
      before = yield* Fixture.digest(v1.dir);
      const planned = yield* migrating(
        {
          node: Option.none(),
          nodeStore: Option.none(),
          tokens: undefined,
          secretsFile: Option.none(),
          sessions: undefined,
        },
        (migrator) => migrator.plan(),
      );
      expect(
        planned.conflicts.map((conflict) => `${conflict.what} ${conflict.label}`).sort(),
      ).toEqual([
        "node none",
        "session signing in",
        "token ci",
        "token default-reader",
        "token one-snapshot",
        "token provisioning",
      ]);
      const applied = yield* Effect.flip(
        migrating({ tokens: undefined }, (migrator) => migrator.apply()),
      );
      expect(applied._tag).toBe("NotMappable");
      expect((yield* (yield* admin).accounts.list()).length).toBe(0);
    }),
  );

  it.effect("with all of it said, the plan is every step and nothing is in the way", () =>
    Effect.gen(function* () {
      const planned = yield* migrating({}, (migrator) => migrator.plan());
      expect(planned.conflicts).toEqual([]);
      expect(planned.steps.length).toBe(STEPS);
      expect(planned.moved).toBe(0);
      const count = (kind: string) => planned.steps.filter((step) => step.kind === kind).length;
      expect({
        user: count("user"),
        tenant: count("tenant"),
        service: count("tenant-service") + count("admin-service"),
        member: count("member"),
        snapshot: count("snapshot"),
        token: count("token"),
      }).toEqual({ user: 3, tenant: 2, service: 3, member: 4, snapshot: 1, token: 4 });
      expect(planned.skipped.map((left) => `${left.what} ${left.label}`)).toEqual(
        expect.arrayContaining([
          "tenant Gone",
          "snapshot dropped",
          "token old",
          "session signing in",
        ]),
      );
      // A plan is no move.
      expect((yield* (yield* admin).accounts.list()).length).toBe(0);
    }),
  );

  it.effect("a move that is cut short keeps what it moved", () =>
    Effect.gen(function* () {
      const failed = yield* Effect.flip(
        migrating(
          { secretsFile: Option.some(`${yield* Scratch}/no-such-directory/secrets.jsonl`) },
          (migrator) => migrator.apply(),
        ),
      );
      expect(failed._tag).toBe("SecretsFileUnusable");
      const accounts = yield* (yield* admin).accounts.list();
      expect(accounts.filter((account) => account.kind === "person").length).toBe(3);
      // The token whose secret had nowhere to go is not there either.
      for (const account of accounts) {
        expect(yield* (yield* admin).accounts.tokensOf({ params: { id: account.id } })).toEqual([]);
      }
    }),
  );

  it.effect("and the next one goes on from there", () =>
    Effect.gen(function* () {
      const planned = yield* migrating({}, (migrator) => migrator.plan());
      // All but the tokens was moved before the first of them failed.
      expect(planned.steps.map((step) => step.kind)).toEqual(["token", "token", "token", "token"]);
      expect(planned.moved).toBe(STEPS - 4);
      const done = yield* migrating({}, (migrator) => migrator.apply());
      expect(done.steps.length).toBe(4);
    }),
  );

  it.effect(
    "the people of v1 are people of v2, an admin an admin and a disabled one disabled",
    () =>
      Effect.gen(function* () {
        const accounts = yield* (yield* admin).accounts.list();
        const people = accounts.filter((account) => account.kind === "person");
        expect(
          people
            .map((person) => ({
              email: person.email,
              name: person.name,
              admin: person.admin,
              disabled: person.disabledAt !== null,
              // Nobody's password came along: each sets one with a setup link.
              password: person.signIn?.password,
            }))
            .sort((a, b) => (a.email ?? "").localeCompare(b.email ?? "")),
        ).toEqual([
          {
            email: "alice@example.com",
            name: "Alice",
            admin: true,
            disabled: false,
            password: false,
          },
          { email: "bob@example.com", name: "Bob", admin: false, disabled: false, password: false },
          {
            email: "carol@example.com",
            name: "Carol",
            admin: false,
            disabled: true,
            password: false,
          },
        ]);
        expect(
          accounts
            .filter((account) => account.kind === "service")
            .map((account) => `${account.name}${account.admin ? " (admin)" : ""}`)
            .sort(),
        ).toEqual(["Admin tokens (from v1) (admin)", "Team (from v1)", "default (from v1)"]);
      }),
  );

  it.effect("a shared tenant is a workspace with who was in it, and a personal one is none", () =>
    Effect.gen(function* () {
      const api = yield* admin;
      const workspaces = yield* api.workspaces.list();
      expect(workspaces.map((workspace) => workspace.name).sort()).toEqual([TEAM, "default"]);
      const team = workspaces.find((workspace) => workspace.name === TEAM)!;
      const members = yield* api.workspaces.members({ params: { id: team.id } });
      expect(members.map((member) => `${member.name} ${member.role}`).sort()).toEqual([
        "Alice admin",
        "Bob member",
        "Team (from v1) admin",
      ]);
    }),
  );

  it.effect("a snapshot is the workspace's, as it was called, said to be and tagged", () =>
    Effect.gen(function* () {
      const api = yield* admin;
      const executor = yield* Executor;
      const team = (yield* api.workspaces.list()).find((workspace) => workspace.name === TEAM)!;
      const snapshots = yield* allSnapshots;
      expect(snapshots).toMatchObject([
        {
          name: SNAPSHOT,
          description: "Alice, signed in to the site",
          tags: { site: "local" },
          workspaceId: team.id,
          shared: false,
        },
      ]);
      // The node itself reads what was written into its store.
      const onNode = yield* executor.client.snapshots.list;
      expect(onNode.map((snapshot) => `${snapshot.id} ${snapshot.name}`)).toEqual([
        `${snapshots[0]!.id} ${SNAPSHOT}`,
      ]);
      expect(snapshots[0]!.id).toBe(nodeId(snapshots[0]!.id));
    }),
  );

  it.effect("the tokens made anew are held to what v1's were", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      expect((yield* secrets).map((line) => line.name).sort()).toEqual([
        "ci",
        "default-reader",
        "one-snapshot",
        "provisioning",
      ]);
      const held = yield* secretOf("one-snapshot");
      const one = yield* control.as(held);
      expect((yield* snapshotsOf(held)).map((snapshot) => snapshot.name)).toEqual([SNAPSHOT]);
      expect((yield* one.accounts.current()).scopes).toEqual(["snapshots:read"]);
      // A token of another tenant is of that tenant's workspace alone.
      const other = yield* control.as(yield* secretOf("default-reader"));
      expect((yield* other.accounts.current()).scopes).toEqual(["sessions:read"]);
      expect((yield* other.workspaces.list()).map((workspace) => workspace.name)).toEqual([
        "default",
      ]);
      const root = yield* control.as(yield* secretOf("provisioning"));
      expect((yield* root.accounts.list()).length).toBe(6);
    }),
  );

  it.effect("a session created from the snapshot is signed in as the browser of v1 was", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const executor = yield* Executor;
      const signed = yield* Signed;
      // With a token that was v1's own: it creates sessions, and reads the snapshot.
      const secret = yield* secretOf("ci");
      const ci = yield* control.as(secret);
      const [snapshot] = yield* snapshotsOf(secret);
      const session = yield* ci.sessions.create({
        payload: { snapshotId: snapshot!.id, workspaceId: snapshot!.workspaceId! },
      });
      yield* until(
        "the session running",
        ci.sessions
          .get({ params: { id: session.id } })
          .pipe(Effect.map((seen) => seen.observedState === "running")),
        "60 seconds",
      );
      const title = yield* Effect.scoped(
        Effect.gen(function* () {
          const cdp = yield* executor.cdp(session.id);
          const created = yield* cdp.call("Target.createTarget", { url: signed.url }, Created);
          const page = yield* cdp.attach(created.targetId);
          return yield* until(
            "the page of the site",
            page
              .evaluate("document.title", Schema.String)
              .pipe(Effect.map((seen) => (seen === "" ? undefined : seen))),
          );
        }),
      );
      expect(title).toBe("signed in as alice");
      yield* ci.sessions.delete({ params: { id: session.id } });
    }),
  );

  it.effect("what was done is in the event log", () =>
    Effect.gen(function* () {
      const page = yield* (yield* admin).events.list({ query: { limit: 200 } });
      const kinds = new Set(page.events.map((event) => event.kind));
      expect([...kinds]).toEqual(
        expect.arrayContaining([
          "account.created",
          "account.disabled",
          "workspace.created",
          "workspace.member_admitted",
          "snapshot.taken",
          "token.created",
        ]),
      );
      events = page.events.length;
    }),
  );

  it.effect("moving again changes nothing", () =>
    Effect.gen(function* () {
      const api = yield* admin;
      const fs = yield* FileSystem.FileSystem;
      const file = `${yield* Scratch}/secrets.jsonl`;
      const written = yield* fs.readFileString(file);
      const done = yield* migrating({}, (migrator) => migrator.apply());
      expect(done.steps).toEqual([]);
      expect(done.conflicts).toEqual([]);
      expect(done.moved).toBe(STEPS);
      expect((yield* api.accounts.list()).length).toBe(6);
      expect((yield* api.workspaces.list()).length).toBe(2);
      expect((yield* allSnapshots).length).toBe(1);
      expect(yield* fs.readFileString(file)).toBe(written);
      expect((yield* api.events.list({ query: { limit: 200 } })).events.length).toBe(events);
      // Nor is anything asked of a node or of a secrets file once all is moved.
      const bare = yield* migrating(
        { node: Option.none(), nodeStore: Option.none(), secretsFile: Option.none() },
        (migrator) => migrator.apply(),
      );
      expect(bare.steps).toEqual([]);
    }),
  );

  it.effect("and v1 is as it was, to the byte", () =>
    Effect.gen(function* () {
      const v1 = yield* Fixture.V1;
      expect(before).not.toBe("");
      expect(yield* Fixture.digest(v1.dir)).toBe(before);
    }),
  );
});
