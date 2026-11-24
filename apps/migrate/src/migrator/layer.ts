import { ProxyConfig } from "@aperture-browser/control-api";
import { Accounts } from "@aperture-browser/control/src/accounts/service.ts";
import { AccountsStore } from "@aperture-browser/control/src/accounts/store.ts";
import { Events } from "@aperture-browser/control/src/events/service.ts";
import { NodesStore } from "@aperture-browser/control/src/nodes/store.ts";
import { SessionsStore } from "@aperture-browser/control/src/sessions/store.ts";
import { SnapshotsStore } from "@aperture-browser/control/src/snapshots/store.ts";
import { Vault } from "@aperture-browser/control/src/vault/service.ts";
import { WorkspacesStore } from "@aperture-browser/control/src/workspaces/store.ts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { NotMappable, StepFailed } from "../errors.ts";
import { NodeStore } from "../node/store.ts";
import { key, plan as planned, type Step } from "../plan.ts";
import { TokenSecrets } from "../secrets/service.ts";
import { V1Source } from "../v1/source.ts";
import { Migrator, type Options } from "./service.ts";

/** What says in an event that it was a move from v1 that did it. */
const FROM = "v1";

const now = Clock.currentTimeMillis.pipe(Effect.map((millis) => new Date(millis)));

/** The tables of what is moved under its own id, each with what the plan knows it as. */
const DELETED = [
  ["account", "accounts"],
  ["token", "api_tokens"],
  ["workspace", "workspaces"],
  ["snapshot", "snapshots"],
  ["session", "sessions"],
] as const;

const Deleted = Schema.Struct({ id: Schema.String, at: Schema.Date });

/** A session's routing as the control plane keeps it before it is sealed. */
const encodeProxy = Schema.encodeSync(Schema.fromJsonString(ProxyConfig));

export const makeMigrator = Effect.fn("Migrator.make")(function* (options: Options) {
  const v1 = yield* V1Source;
  const nodeStore = yield* NodeStore;
  const secrets = yield* TokenSecrets;
  const accounts = yield* Accounts;
  const accountsStore = yield* AccountsStore;
  const workspaces = yield* WorkspacesStore;
  const snapshots = yield* SnapshotsStore;
  const sessions = yield* SessionsStore;
  const nodes = yield* NodesStore;
  const vault = yield* Vault;
  const events = yield* Events;
  const sql = yield* SqlClient.SqlClient;

  const node = Effect.fn(function* () {
    return options.node === undefined ? Option.none() : yield* nodes.findByName(options.node);
  });

  /** What v2 has that something of v1 may be, and when each was made. */
  const known = Effect.fn(function* () {
    const made = new Map<string, Date>();
    const members = new Set<string>();
    const people = new Map<string, string>();
    for (const account of yield* accountsStore.list()) {
      made.set(key("account", account.id), DateTime.toDate(account.createdAt));
      if (account.email !== null) {
        people.set(account.email.toLowerCase(), account.id);
      }
      for (const token of yield* accountsStore.listTokens(account.id)) {
        made.set(key("token", token.id), DateTime.toDate(token.createdAt));
      }
    }
    for (const workspace of yield* workspaces.list()) {
      made.set(key("workspace", workspace.id), DateTime.toDate(workspace.createdAt));
      for (const member of yield* workspaces.members(workspace.id)) {
        members.add(`${workspace.id}:${member.accountId}`);
      }
    }
    for (const snapshot of yield* snapshots.list()) {
      made.set(key("snapshot", snapshot.id), DateTime.toDate(snapshot.createdAt));
    }
    for (const session of yield* sessions.list()) {
      made.set(key("session", session.id), DateTime.toDate(session.createdAt));
    }
    // What was moved and deleted in v2 since is kept under its id, and stays deleted: the
    // stores tell of none of it, so the tables are asked.
    for (const [kind, table] of DELETED) {
      const rows = yield* sql`
        SELECT id::text AS id, created_at AS at FROM ${sql(table)} WHERE deleted_at IS NOT NULL
      `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Deleted))), Effect.orDie);
      for (const row of rows) {
        made.set(key(kind, row.id), row.at);
      }
    }
    return { made, members, people };
  });

  const plan = Effect.fn("Migrator.plan")(function* () {
    const data = yield* v1.read();
    if (options.node !== undefined) {
      yield* nodeStore.check();
    }
    return planned(
      data,
      {
        ...(yield* known()),
        node:
          options.node === undefined
            ? undefined
            : { name: options.node, known: Option.isSome(yield* node()) },
        secretsFile: options.secretsFile,
      },
      options,
      yield* now,
    );
  });

  const take = Effect.fn(function* (step: Step) {
    const label =
      "name" in step ? step.name : step.kind === "member" ? step.label : (step.label ?? step.id);
    const failed = (reason: string) => new StepFailed({ what: step.kind, label, reason });
    const on = node().pipe(
      Effect.flatMap(Effect.fromOption),
      Effect.mapError(() => failed("the control plane knows no node to keep it on")),
    );

    switch (step.kind) {
      case "person": {
        const account = yield* accounts
          .create({
            name: step.name,
            admin: step.admin,
            kind: "person",
            email: step.email,
            from: step,
          })
          .pipe(Effect.mapError((error) => failed(error.message)));
        if (step.disabledAt !== null) {
          yield* accountsStore.setDisabled(account.id, step.disabledAt);
          yield* events.record({
            kind: "account.disabled",
            resource: { kind: "account", id: account.id, label: account.name },
            ownerId: account.id,
            detail: { from: FROM },
          });
        }
        return;
      }
      case "bearer": {
        yield* accounts
          .create({
            name: step.name,
            admin: step.admin,
            kind: "service",
            email: undefined,
            from: step,
          })
          .pipe(Effect.mapError((error) => failed(error.message)));
        return;
      }
      case "workspace": {
        const workspace = yield* workspaces.insert(step);
        yield* events.record({
          kind: "workspace.created",
          resource: { kind: "workspace", id: workspace.id, label: workspace.name },
          workspaceId: workspace.id,
          detail: { from: FROM },
        });
        return;
      }
      case "member": {
        yield* workspaces.admit(step.workspaceId, step.accountId, step.role);
        yield* events.record({
          kind: "workspace.member_admitted",
          resource: { kind: "workspace", id: step.workspaceId, label: null },
          workspaceId: step.workspaceId,
          ownerId: step.accountId,
          detail: { accountId: step.accountId, role: step.role, from: FROM },
        });
        return;
      }
      case "snapshot": {
        const kept = yield* on;
        // A session the node need not have: the snapshot names it, and nothing looks for it.
        const sessionId = step.sessionId ?? step.id;
        yield* nodeStore.putSnapshot({ ...step, sessionId });
        yield* snapshots.insert({ ...step, sessionId, nodeId: kept.id, shared: false });
        yield* events.record({
          kind: "snapshot.taken",
          resource: { kind: "snapshot", id: step.id, label: step.name },
          ownerId: step.accountId,
          workspaceId: step.workspaceId,
          detail: { from: FROM },
        });
        return;
      }
      case "session": {
        const kept = yield* on;
        if (step.layer !== null && step.layer.profile !== null) {
          yield* nodeStore.putLayer({
            id: step.layer.id,
            name: `the snapshot session ${label} stands on`,
            profile: step.layer.profile,
          });
        }
        yield* nodeStore.putSession({
          id: step.id,
          name: `session ${label}`,
          createdAt: step.createdAt,
          snapshotId: step.snapshotId,
          layer: step.layer?.id ?? null,
          proxy: step.proxy,
          upper: step.upper,
          files: step.files,
        });
        yield* sessions.insert({
          id: step.id,
          accountId: step.accountId,
          workspaceId: step.workspaceId,
          nodeId: kept.id,
          desiredState: "suspended",
          observedState: "suspended",
          failure: null,
          snapshotId: step.snapshotId,
          label: step.label,
          tags: step.tags,
          createdAt: step.createdAt,
          now: yield* now,
        });
        if (step.proxy !== null) {
          yield* sessions.keepProxy(step.id, yield* vault.seal(encodeProxy(step.proxy), step.id));
        }
        yield* events.record({
          kind: "session.created",
          resource: { kind: "session", id: step.id, label: step.label },
          ownerId: step.accountId,
          workspaceId: step.workspaceId,
          detail: { from: FROM },
        });
        return;
      }
      case "token": {
        const lasts =
          step.expiresAt === null
            ? undefined
            : Duration.millis(Math.max(1, step.expiresAt.getTime() - (yield* now).getTime()));
        const { token, secret } = yield* accounts
          .createToken(
            step.accountId,
            step.name,
            lasts,
            step.scopes,
            step.resources ?? undefined,
            step,
          )
          .pipe(Effect.mapError((error) => failed(error.message)));
        const owner = yield* accountsStore.find(step.accountId);
        yield* secrets.keep({
          id: token.id,
          account: Option.match(owner, {
            onNone: () => step.accountId,
            onSome: (found) => found.name,
          }),
          name: token.name,
          secret,
        });
        return;
      }
    }
  });

  const apply = Effect.fn("Migrator.apply")(function* () {
    const todo = yield* plan();
    if (todo.conflicts.length > 0) {
      return yield* new NotMappable({ conflicts: todo.conflicts.length });
    }
    for (const step of todo.steps) {
      // All a step writes into the database is kept or none of it, so that what v2 has
      // under an id is whole, and what it lacks is made by the next run.
      yield* take(step).pipe(sql.withTransaction, Effect.catchTag("SqlError", Effect.die));
    }
    return todo;
  });

  return Migrator.of({ plan, apply });
});

export const layer = (options: Options) => Layer.effect(Migrator, makeMigrator(options));
