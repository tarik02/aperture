import * as Control from "@aperture-browser/control/tests/src/control.ts";
import { Executor } from "@aperture-browser/e2e/src/executor.ts";
import { follow } from "@aperture-browser/e2e/src/http.ts";
import { directory } from "@aperture-browser/e2e/src/process.ts";
import * as Site from "@aperture-browser/e2e/src/site.ts";
import { suite } from "@aperture-browser/e2e/src/suite.ts";
import { until } from "@aperture-browser/e2e/src/wait.ts";
import { expect } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as App from "../src/app.ts";
import { Migrator, type MigratorShape } from "../src/migrator/service.ts";
import { nodeId } from "../src/plan.ts";
import { Line } from "../src/secrets/file.ts";
import { sessionOf } from "../src/v1/source-sqlite.ts";
import * as Fixture from "./src/fixture.ts";
import * as Node from "./src/node.ts";

/** The site v1's browsers were signed in to, as the recording served it. */
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
/** The session that signed in: suspended, with a file, a recording and routing of its own. */
const SIGNED_IN = "signing in";
/** The session created from the snapshot, which ran when v1 stopped. */
const LEFT_RUNNING = "left running";
/** The session of a personal tenant. */
const OWN = "alice's own";
/** Where the site was when the fixture was recorded, which v1's tabs still name. */
const RECORDED_SITE = "http://127.0.0.1:18081";
/**
 * Three people, two workspaces, three service accounts for the tokens, four members, a
 * snapshot, three sessions, five tokens.
 */
const STEPS = 21;
const TOKENS = ["alice-own", "ci", "default-reader", "one-snapshot", "provisioning"];

const Created = Schema.Struct({ targetId: Schema.String });
const Targets = Schema.Struct({
  targetInfos: Schema.Array(Schema.Struct({ type: Schema.String, url: Schema.String })),
});
const Lines = Schema.Array(Line);
const Tables = Schema.Array(Schema.Struct({ name: Schema.String }));

/** When something was made, as v1's rows and v2's answers both tell it. */
const millis = (at: DateTime.Utc) => DateTime.toEpochMillis(at);

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
        v1StoreRoot: Option.none(),
        node: Option.some(Node.NODE),
        nodeStore: Option.some(executor.data),
        tokens: "reissue",
        secretsFile: Option.some(`${yield* Scratch}/secrets.jsonl`),
        sessions: undefined,
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

  /** A row of v1's own database, by what v1 called what it is of. */
  const inV1 = (table: keyof Fixture.V1["Service"]["rows"], name: string) =>
    Effect.gen(function* () {
      const v1 = yield* Fixture.V1;
      return yield* Effect.fromNullishOr(v1.rows[table].find((row) => row.name === name));
    });

  /** A session of v2, by what it is called. */
  const sessionCalled = (label: string) =>
    Effect.gen(function* () {
      const sessions = yield* (yield* admin).sessions.list({ query: {} });
      return yield* Effect.fromNullishOr(sessions.find((session) => session.label === label));
    });

  /** The addresses of the pages a session's browser has. */
  const pagesOf = (id: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cdp = yield* (yield* Executor).cdp(id);
        const { targetInfos } = yield* cdp.call("Target.getTargets", {}, Targets);
        return targetInfos.filter((target) => target.type === "page").map((target) => target.url);
      }),
    );

  /** What the site calls whoever a session's browser is to it. */
  const titleIn = (id: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cdp = yield* (yield* Executor).cdp(id);
        const created = yield* cdp.call(
          "Target.createTarget",
          { url: (yield* Signed).url },
          Created,
        );
        const page = yield* cdp.attach(created.targetId);
        return yield* until(
          "the page of the site",
          page
            .evaluate("document.title", Schema.String)
            .pipe(Effect.map((seen) => (seen === "" ? undefined : seen))),
        );
      }),
    );

  let before = "";
  let events = 0;

  it.effect("with nothing said, the plan tells what is in the way and moves nothing", () =>
    Effect.gen(function* () {
      const v1 = yield* Fixture.V1;
      before = yield* Fixture.digest(v1.dir);
      const unsaid = {
        node: Option.none(),
        nodeStore: Option.none(),
        tokens: "keep",
        secretsFile: Option.none(),
      } as const;
      const planned = yield* migrating(unsaid, (migrator) => migrator.plan());
      // Its tokens are kept as they were, which needs nowhere to write a secret.
      expect(planned.conflicts.map((conflict) => `${conflict.what} ${conflict.label}`)).toEqual([
        "node none",
      ]);
      const applied = yield* Effect.flip(migrating(unsaid, (migrator) => migrator.apply()));
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
        person: count("person"),
        workspace: count("workspace"),
        bearer: count("bearer"),
        member: count("member"),
        snapshot: count("snapshot"),
        session: count("session"),
        token: count("token"),
      }).toEqual({
        person: 3,
        workspace: 2,
        bearer: 3,
        member: 4,
        snapshot: 1,
        session: 3,
        token: 5,
      });
      expect(
        planned.steps.flatMap((step) =>
          step.kind === "session" ? [`${step.label}${step.wasRunning ? ", ran" : ""}`] : [],
        ),
      ).toEqual([SIGNED_IN, OWN, `${LEFT_RUNNING}, ran`]);
      expect(planned.skipped.map((left) => `${left.what} ${left.label}`)).toEqual(
        expect.arrayContaining(["tenant Gone", "snapshot dropped", "token old"]),
      );
      expect(planned.notes.map((note) => `${note.what} ${note.label}`)).toEqual([
        "token alice-own",
      ]);
      // Left behind where that is said, and then no node is asked for on their account.
      const without = yield* migrating({ sessions: "drop" }, (migrator) => migrator.plan());
      expect(without.steps.length).toBe(STEPS - 3);
      expect(without.skipped.filter((left) => left.what === "session").length).toBe(3);
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
      expect(planned.steps.map((step) => step.kind)).toEqual(TOKENS.map(() => "token"));
      expect(planned.moved).toBe(STEPS - TOKENS.length);
      const done = yield* migrating({}, (migrator) => migrator.apply());
      expect(done.steps.length).toBe(TOKENS.length);
    }),
  );

  it.effect(
    "the people of v1 are people of v2, an admin an admin and a disabled one disabled",
    () =>
      Effect.gen(function* () {
        const v1 = yield* Fixture.V1;
        const accounts = yield* (yield* admin).accounts.list();
        const people = accounts.filter((account) => account.kind === "person");
        expect(
          people
            .map((person) => ({
              email: person.email,
              name: person.name,
              admin: person.admin,
              disabled: person.disabledAt !== null,
              // The recording has no password of anyone's: each sets one with a setup link.
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
        // Each is who they were: the id v1 gave them, and as old as v1 says.
        expect(
          people.map((person) => `${person.email} ${person.id} ${millis(person.createdAt)}`).sort(),
        ).toEqual(
          v1.rows.users.map((user) => `${user.name} ${user.id} ${user.createdAt.getTime()}`).sort(),
        );
        // The only accounts that were no user's bear the tokens that were no user's.
        expect(
          accounts
            .filter((account) => account.kind === "service")
            .map((account) => `${account.name}${account.admin ? " (admin)" : ""}`)
            .sort(),
        ).toEqual([
          "Admin tokens (from v1) (admin)",
          "Team tokens (from v1)",
          "default tokens (from v1)",
        ]);
      }),
  );

  it.effect("a shared tenant is a workspace with who was in it, and a personal one is none", () =>
    Effect.gen(function* () {
      const api = yield* admin;
      const workspaces = yield* api.workspaces.list();
      expect(workspaces.map((workspace) => workspace.name).sort()).toEqual([TEAM, "default"]);
      for (const workspace of workspaces) {
        const tenant = yield* inV1("tenants", workspace.name);
        expect([workspace.id, millis(workspace.createdAt)]).toEqual([
          tenant.id,
          tenant.createdAt.getTime(),
        ]);
      }
      const team = workspaces.find((workspace) => workspace.name === TEAM)!;
      const members = yield* api.workspaces.members({ params: { id: team.id } });
      expect(members.map((member) => `${member.name} ${member.role}`).sort()).toEqual([
        "Alice admin",
        "Bob member",
        // One of its tokens says who is in the workspace, which is an admin's to say.
        "Team tokens (from v1) admin",
      ]);
      const other = workspaces.find((workspace) => workspace.name === "default")!;
      expect(
        (yield* api.workspaces.members({ params: { id: other.id } })).map(
          (member) => `${member.name} ${member.role}`,
        ),
      ).toEqual(["default tokens (from v1) member"]);
    }),
  );

  it.effect("a snapshot is the workspace's and nobody's in particular, as it was in v1", () =>
    Effect.gen(function* () {
      const api = yield* admin;
      const executor = yield* Executor;
      const kept = yield* inV1("snapshots", SNAPSHOT);
      const team = yield* inV1("tenants", TEAM);
      const snapshots = yield* api.snapshots.list({ query: {} });
      expect(snapshots).toMatchObject([
        {
          id: nodeId(kept.id),
          name: SNAPSHOT,
          description: "Alice, signed in to the site",
          tags: { site: "local" },
          workspaceId: team.id,
          // No account was made up for it to be of.
          accountId: null,
          sessionId: nodeId((yield* inV1("sessions", SIGNED_IN)).id),
          shared: false,
        },
      ]);
      expect(millis(snapshots[0]!.createdAt)).toBe(kept.createdAt.getTime());
      // The node itself reads what was written into its store.
      const onNode = yield* executor.client.snapshots.list;
      expect(onNode.map((snapshot) => `${snapshot.id} ${snapshot.name}`)).toEqual([
        `${nodeId(kept.id)} ${SNAPSHOT}`,
      ]);
    }),
  );

  it.effect("a session is whose it was, as it was called, tagged and routed, and suspended", () =>
    Effect.gen(function* () {
      const api = yield* admin;
      const executor = yield* Executor;
      const team = yield* inV1("tenants", TEAM);
      const alice = yield* inV1("users", "alice@example.com");
      const snapshot = yield* inV1("snapshots", SNAPSHOT);
      const sessions = yield* api.sessions.list({ query: {} });
      const told = (label: string) => sessions.find((session) => session.label === label);
      const suspended = { desiredState: "suspended", observedState: "suspended", failure: null };
      expect(told(SIGNED_IN)).toMatchObject({
        ...suspended,
        workspaceId: team.id,
        accountId: null,
        snapshotId: null,
        tags: { purpose: "fixture" },
      });
      expect(told(LEFT_RUNNING)).toMatchObject({
        ...suspended,
        workspaceId: team.id,
        accountId: null,
        snapshotId: nodeId(snapshot.id),
        tags: {},
      });
      expect(told(OWN)).toMatchObject({ ...suspended, workspaceId: null, accountId: alice.id });
      for (const session of sessions) {
        const kept = yield* inV1("sessions", session.label ?? "");
        expect([session.id, millis(session.createdAt)]).toEqual([
          nodeId(kept.id),
          kept.createdAt.getTime(),
        ]);
      }
      expect(sessions.length).toBe(3);
      // The node has them, each suspended.
      const onNode = yield* executor.client.sessions.list;
      expect(onNode.map((session) => session.id).sort()).toEqual(
        sessions.map((session) => session.id).sort(),
      );
      // Its routing is what v1 had, the rule that names an IPv6 address with the others.
      expect(yield* api.sessions.proxy({ params: { id: told(SIGNED_IN)!.id } })).toEqual({
        proxy: {
          upstreams: { corp: { url: "socks5://user:secret@proxy.invalid:1080" } },
          rules: [
            { match: "*.corp.test", via: "corp" },
            { match: "blocked.test:443", via: "refuse" },
            { match: "[2001:db8::1]:443", via: "refuse" },
          ],
        },
      });
      expect(yield* api.sessions.proxy({ params: { id: told(OWN)!.id } })).toEqual({ proxy: null });
    }),
  );

  it.effect("the tokens made anew are the tokens of v1, held to what those were", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const api = yield* admin;
      const v1 = yield* Fixture.V1;
      expect((yield* secrets).map((line) => line.name).sort()).toEqual(TOKENS);
      // Each has the id of the one it is in place of, and is as old.
      const made = yield* Effect.forEach(yield* api.accounts.list(), (account) =>
        api.accounts.tokensOf({ params: { id: account.id } }),
      );
      const live = v1.rows.api_tokens.filter((token) => token.name !== "old");
      expect(
        made
          .flat()
          .map((token) => `${token.name} ${token.id} ${millis(token.createdAt)}`)
          .sort(),
      ).toEqual(
        live.map((token) => `${token.name} ${token.id} ${token.createdAt.getTime()}`).sort(),
      );
      expect((yield* secrets).map((line) => line.id).sort()).toEqual(
        live.map((token) => token.id).sort(),
      );

      const held = yield* control.as(yield* secretOf("one-snapshot"));
      expect((yield* held.snapshots.list({ query: {} })).map((snapshot) => snapshot.name)).toEqual([
        SNAPSHOT,
      ]);
      expect((yield* held.accounts.current()).scopes).toEqual(["snapshots:read"]);
      // A token of another tenant is of that tenant's workspace alone.
      const other = yield* control.as(yield* secretOf("default-reader"));
      expect((yield* other.accounts.current()).scopes).toEqual(["sessions:read"]);
      expect((yield* other.workspaces.list()).map((workspace) => workspace.name)).toEqual([
        "default",
      ]);
      expect(yield* other.sessions.list({ query: {} })).toEqual([]);
      // A personal tenant's is its owner's own, and reaches what is theirs.
      const own = yield* control.as(yield* secretOf("alice-own"));
      expect((yield* own.accounts.current()).id).toBe(
        (yield* inV1("users", "alice@example.com")).id,
      );
      // That is more than it reached in v1, where it was of her tenant alone, and the plan
      // said so: v2 holds no token to what is its account's own.
      expect(
        (yield* own.sessions.list({ query: {} })).map((session) => `${session.label}`).sort(),
      ).toEqual([OWN, LEFT_RUNNING, SIGNED_IN].sort());
      // A system administrator's is the account's that the installation names.
      const root = yield* control.as(yield* secretOf("provisioning"));
      expect((yield* root.accounts.list()).length).toBe(6);
      expect((yield* root.accounts.current()).name).toBe("Admin tokens (from v1)");
    }),
  );

  it.effect("a session created from the snapshot is signed in as the browser of v1 was", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      // With a token that was v1's own: it creates sessions, and reads the snapshot.
      const ci = yield* control.as(yield* secretOf("ci"));
      const [snapshot] = yield* ci.snapshots.list({ query: {} });
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
      expect(yield* titleIn(session.id)).toBe("signed in as alice");
      yield* ci.sessions.delete({ params: { id: session.id } });
    }),
  );

  it.effect("a session of v1 resumes signed in, with its page, its file and its recording", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const fs = yield* FileSystem.FileSystem;
      const v1 = yield* Fixture.V1;
      const ci = yield* control.as(yield* secretOf("ci"));
      const session = yield* sessionCalled(SIGNED_IN);
      const at = { params: { id: session.id } };
      yield* ci.sessions.resume(at);
      yield* until(
        "the session running",
        ci.sessions.get(at).pipe(Effect.map((seen) => seen.observedState === "running")),
        "60 seconds",
      );
      // The page it had in v1 is the page it has.
      yield* until(
        "the page it had",
        pagesOf(session.id).pipe(Effect.map((pages) => pages.includes(`${RECORDED_SITE}/login`))),
      );
      expect(yield* titleIn(session.id)).toBe("signed in as alice");

      const read = (path: string) =>
        ci.sessions
          .createFileLink({ ...at, payload: { path } })
          .pipe(Effect.flatMap((link) => follow(link.url)));
      const note = yield* read("uploads/note.txt");
      expect([note.status, new TextDecoder().decode(note.bytes)]).toEqual([200, "kept from v1\n"]);
      // A recording of v1 is a video among the session's files, and is served as one.
      const where = sessionOf(
        { database: v1.database, coldRoot: v1.dir, storeRoot: v1.dir },
        (yield* inV1("sessions", SIGNED_IN)).id,
      );
      const recordings = yield* fs.readDirectory(`${where.files}/recordings`);
      const video = yield* Effect.fromNullishOr(recordings.find((name) => name.endsWith(".webm")));
      const served = yield* read(`recordings/${video}`);
      expect(served.status).toBe(200);
      const kept = yield* fs.readFile(`${where.files}/recordings/${video}`);
      expect(kept.length).toBeGreaterThan(1000);
      expect(Array.from(served.bytes)).toEqual(Array.from(kept));
      // What v1 kept among the files for itself did not come along.
      expect(yield* fs.exists(`${where.files}/.lock`)).toBe(true);
      expect(yield* fs.exists(`${(yield* Executor).data}/sessions/${session.id}/files/.lock`)).toBe(
        false,
      );

      yield* ci.sessions.suspend(at);
      yield* until(
        "the session suspended",
        ci.sessions.get(at).pipe(Effect.map((seen) => seen.observedState === "suspended")),
        "60 seconds",
      );
    }),
  );

  it.effect(
    "a session that ran when v1 stopped resumes above its snapshot, with both its pages",
    () =>
      Effect.gen(function* () {
        const control = yield* Control.Control;
        const ci = yield* control.as(yield* secretOf("ci"));
        const session = yield* sessionCalled(LEFT_RUNNING);
        const at = { params: { id: session.id } };
        yield* ci.sessions.resume(at);
        yield* until(
          "the session running",
          ci.sessions.get(at).pipe(Effect.map((seen) => seen.observedState === "running")),
          "60 seconds",
        );
        yield* until(
          "the pages it had",
          pagesOf(session.id).pipe(
            Effect.map((pages) =>
              ["first", "second"].every((page) => pages.includes(`${RECORDED_SITE}/${page}`)),
            ),
          ),
        );
        // Signed in by what its snapshot holds, which it never wrote itself.
        expect(yield* titleIn(session.id)).toBe("signed in as alice");
        yield* ci.sessions.suspend(at);
        yield* until(
          "the session suspended",
          ci.sessions.get(at).pipe(Effect.map((seen) => seen.observedState === "suspended")),
          "60 seconds",
        );
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
          "session.created",
          "token.created",
        ]),
      );
      events = page.events.length;
    }),
  );

  it.effect("moving again changes nothing, and nothing of the move is kept in v2", () =>
    Effect.gen(function* () {
      const api = yield* admin;
      const control = yield* Control.Control;
      const fs = yield* FileSystem.FileSystem;
      const file = `${yield* Scratch}/secrets.jsonl`;
      const written = yield* fs.readFileString(file);
      const done = yield* migrating({}, (migrator) => migrator.apply());
      expect(done.steps).toEqual([]);
      expect(done.conflicts).toEqual([]);
      expect(done.moved).toBe(STEPS);
      expect((yield* api.accounts.list()).length).toBe(6);
      expect((yield* api.workspaces.list()).length).toBe(2);
      expect((yield* api.snapshots.list({ query: {} })).length).toBe(1);
      expect((yield* api.sessions.list({ query: {} })).length).toBe(3);
      expect(yield* fs.readFileString(file)).toBe(written);
      expect((yield* api.events.list({ query: { limit: 200 } })).events.length).toBe(events);
      // Nor is anything asked of a node or of a secrets file once all is moved.
      const bare = yield* migrating(
        { node: Option.none(), nodeStore: Option.none(), secretsFile: Option.none() },
        (migrator) => migrator.apply(),
      );
      expect(bare.steps).toEqual([]);
      // The database holds what the control plane keeps, and no table of the migrator's.
      const { sql } = control;
      const tables = yield* sql`
        SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public'
      `.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Tables)),
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      expect(tables.length).toBeGreaterThan(10);
      // The control plane's table of v1's tokens is empty: these were made anew.
      expect(tables.map((table) => table.name).filter((name) => /moved|v1/u.test(name))).toEqual([
        "v1_api_tokens",
      ]);
      expect(
        yield* sql`SELECT * FROM v1_api_tokens`.pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        ),
      ).toEqual([]);
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
