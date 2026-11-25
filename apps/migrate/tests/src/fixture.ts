import { directory } from "@aperture-browser/e2e/src/process.ts";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Schema from "effect/Schema";

/** The recorded v1 could not be laid out. */
export class FixtureUnusable extends Schema.TaggedError<FixtureUnusable>()("FixtureUnusable", {
  step: Schema.String,
}) {}

const done = (step: string, program: string, args: ReadonlyArray<string>) =>
  ChildProcessSpawner.ChildProcessSpawner.use((spawner) =>
    spawner.exitCode(
      ChildProcess.make(program, args, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }),
    ),
  ).pipe(
    Effect.orElseSucceed(() => 1),
    Effect.flatMap((code) =>
      code === 0 ? Effect.void : Effect.fail(new FixtureUnusable({ step })),
    ),
  );

/** What says what a directory holds, to the byte: every file's digest, in order. */
export const digest = (dir: string) =>
  ChildProcessSpawner.ChildProcessSpawner.use((spawner) =>
    spawner.string(
      ChildProcess.make(
        "sh",
        ["-c", 'cd "$1" && find . -type f -print0 | sort -z | xargs -0 sha256sum', "sh", dir],
        {
          stdin: "ignore",
          stderr: "ignore",
        },
      ),
    ),
  );

/** What v1 called something, with the id it gave it and when it made it. */
const Row = Schema.Struct({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
  createdAt: Schema.DateFromString,
});
const Rows = Schema.Array(Row);
type Rows = typeof Rows.Type;

/** The tables whose rows v2 has under the ids v1 gave them, each with what names a row. */
const TABLES = {
  users: "email",
  tenants: "display_name",
  snapshots: "name",
  sessions: "label",
  api_tokens: "name",
} as const;

/**
 * The v1 installation `fixture/record.sh` recorded from a real v1, laid out as v1 left it
 * and made read-only: a migrator that writes to it fails.
 */
export class V1 extends Context.Service<
  V1,
  {
    /** v1's store and cold root. */
    readonly dir: string;
    readonly database: string;
    /** What v1's own database says of what it has, read by nothing of the migrator's. */
    readonly rows: Readonly<Record<keyof typeof TABLES, Rows>>;
  }
>()("@aperture-browser/migrate/tests/V1") {}

/** v1's rows, read as a file nothing changes, which is how a locked directory's is read. */
const rows = Effect.fn(
  function* (database: string) {
    const sql = yield* SqliteClient.make({
      filename: `file:${encodeURI(database)}?mode=ro&immutable=1`,
      readonly: true,
      disableWAL: true,
    });
    const read = (table: keyof typeof TABLES) =>
      sql
        .unsafe(
          `SELECT id, ${TABLES[table]} AS name, created_at AS "createdAt" FROM ${table} ORDER BY created_at, id`,
        )
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Rows)));
    return {
      users: yield* read("users"),
      tenants: yield* read("tenants"),
      snapshots: yield* read("snapshots"),
      sessions: yield* read("sessions"),
      api_tokens: yield* read("api_tokens"),
    };
  },
  Effect.scoped,
  Effect.provide(Reactivity.layer),
  Effect.orDie,
);

/**
 * What a v1 its people used has beside what `record.sh` made, which keeps no secret: their
 * passwords and second factors, by address, and the digests of tokens whose secrets are
 * known, by name.
 */
export interface Credentials {
  readonly passwords?: Readonly<Record<string, string>>;
  readonly secondFactors?: Readonly<Record<string, string>>;
  readonly tokens?: Readonly<Record<string, string>>;
}

/** Writes them into v1's database as v1 writes them. */
const give = Effect.fn(
  function* (database: string, credentials: Credentials) {
    // The recording as it is, untouched, where nothing is given.
    if (Object.values(credentials).every((given) => Object.keys(given).length === 0)) {
      return;
    }
    const sql = yield* SqliteClient.make({ filename: database, disableWAL: true });
    for (const [email, hash] of Object.entries(credentials.passwords ?? {})) {
      yield* sql`
        INSERT INTO user_passwords (user_id, password_hash, created_at, updated_at)
        SELECT id, ${hash}, created_at, created_at FROM users WHERE email = ${email}
      `;
    }
    for (const [email, secret] of Object.entries(credentials.secondFactors ?? {})) {
      yield* sql`
        INSERT INTO totp_credentials (user_id, secret, created_at, updated_at)
        SELECT id, ${secret}, created_at, created_at FROM users WHERE email = ${email}
      `;
    }
    for (const [name, digest] of Object.entries(credentials.tokens ?? {})) {
      yield* sql`UPDATE api_tokens SET token_hash = ${digest} WHERE name = ${name}`;
    }
  },
  Effect.scoped,
  Effect.provide(Reactivity.layer),
  Effect.orDie,
);

export const layerWith = (credentials: Credentials) =>
  Layer.effect(
    V1,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const archive = yield* path.fromFileUrl(new URL("../fixture/v1.tar.gz", import.meta.url));
      const dir = yield* Effect.acquireRelease(directory, (made) =>
        // What is read-only is not removed with the directory otherwise.
        Effect.ignore(done("unlock", "chmod", ["-R", "u+w", made])),
      );
      // With what overlayfs keeps in a session's upper directory: the attributes that say a
      // directory hides what is below it, and the devices that say a file is gone.
      yield* done("unpack", "tar", [
        "--xattrs",
        "--xattrs-include=user.*",
        "-xzf",
        archive,
        "-C",
        dir,
      ]);
      const database = `${dir}/aperture.db`;
      yield* give(database, credentials);
      yield* done("lock", "chmod", ["-R", "a-w", dir]);
      return { dir, database, rows: yield* rows(database) };
    }),
  );

export const layer = layerWith({});
