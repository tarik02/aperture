import { AccountsStore } from "@aperture-browser/control/src/accounts/store.ts";
import { Accounts } from "@aperture-browser/control/src/accounts/service.ts";
import { Events } from "@aperture-browser/control/src/events/service.ts";
import { NodesStore } from "@aperture-browser/control/src/nodes/store.ts";
import { SnapshotsStore } from "@aperture-browser/control/src/snapshots/store.ts";
import { WorkspacesStore } from "@aperture-browser/control/src/workspaces/store.ts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { NotMappable, StepFailed } from "../errors.ts";
import { MovedStore } from "../moved/store.ts";
import { NodeSnapshots } from "../node/snapshots.ts";
import { key, nodeId, plan as planned, resourcesOf, type Step } from "../plan.ts";
import { TokenSecrets } from "../secrets/service.ts";
import { V1Source } from "../v1/source.ts";
import { Migrator, type Options } from "./service.ts";

/** What says in an event that it was a move from v1 that did it. */
const FROM = "v1";

const now = Clock.currentTimeMillis.pipe(Effect.map((millis) => new Date(millis)));

export const makeMigrator = Effect.fn("Migrator.make")(function* (options: Options) {
  const v1 = yield* V1Source;
  const moved = yield* MovedStore;
  const nodeSnapshots = yield* NodeSnapshots;
  const secrets = yield* TokenSecrets;
  const accounts = yield* Accounts;
  const accountsStore = yield* AccountsStore;
  const workspaces = yield* WorkspacesStore;
  const snapshots = yield* SnapshotsStore;
  const nodes = yield* NodesStore;
  const events = yield* Events;
  const sql = yield* SqlClient.SqlClient;

  const node = Effect.fn(function* () {
    return options.node === undefined ? Option.none() : yield* nodes.findByName(options.node);
  });

  const plan = Effect.fn("Migrator.plan")(function* () {
    const data = yield* v1.read();
    if (options.node !== undefined) {
      yield* nodeSnapshots.check();
    }
    const people = yield* accountsStore.list();
    return planned(
      data,
      {
        moved: yield* moved.all(),
        people: new Map(
          people.flatMap((account) =>
            account.email === null ? [] : [[account.email.toLowerCase(), account.id] as const],
          ),
        ),
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

  /** Does a step, and gives what it made is in v2. */
  const take = Effect.fn(function* (step: Step, ids: ReadonlyMap<string, string>) {
    const failed = (reason: string) =>
      new StepFailed({ what: step.kind, label: "name" in step ? step.name : step.label, reason });
    /** What an earlier step made, which this one is about. */
    const made = (of: string) =>
      Effect.fromNullishOr(ids.get(of)).pipe(
        Effect.mapError(() => failed(`${of} was not moved before it`)),
      );

    switch (step.kind) {
      case "user": {
        if (step.joins !== null) {
          return step.joins;
        }
        const account = yield* accounts
          .create({ name: step.name, admin: step.admin, kind: "person", email: step.email })
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
        return account.id;
      }
      case "tenant-service":
      case "admin-service": {
        const account = yield* accounts
          .create({ name: step.name, admin: step.admin, kind: "service", email: undefined })
          .pipe(Effect.mapError((error) => failed(error.message)));
        return account.id;
      }
      case "tenant": {
        // A tenant's id is a workspace's as it is: both are UUIDs.
        const workspace = yield* workspaces.insert({
          id: step.v1Id,
          name: step.name,
          createdAt: step.createdAt,
        });
        yield* events.record({
          kind: "workspace.created",
          resource: { kind: "workspace", id: workspace.id, label: workspace.name },
          workspaceId: workspace.id,
          detail: { from: FROM },
        });
        return workspace.id;
      }
      case "member": {
        const workspace = yield* made(key("tenant", step.tenant));
        const account = yield* made(step.account);
        yield* workspaces.admit(workspace, account, step.role);
        yield* events.record({
          kind: "workspace.member_admitted",
          resource: { kind: "workspace", id: workspace, label: null },
          workspaceId: workspace,
          ownerId: account,
          detail: { accountId: account, role: step.role, from: FROM },
        });
        return `${workspace}:${account}`;
      }
      case "snapshot": {
        const account = yield* made(step.account);
        const workspace = step.tenant === null ? null : yield* made(key("tenant", step.tenant));
        const on = yield* node().pipe(
          Effect.flatMap(Effect.fromOption),
          Effect.mapError(() => failed("the control plane knows no node to keep it on")),
        );
        const id = nodeId(step.v1Id);
        // A session the node never had: the snapshot names it, and nothing looks for it.
        const sessionId = nodeId(step.sessionId ?? step.v1Id);
        yield* nodeSnapshots.put({
          id,
          name: step.name,
          sessionId,
          createdAt: step.createdAt,
          profile: step.profile,
        });
        const kept = yield* snapshots.insert({
          id,
          accountId: account,
          workspaceId: workspace,
          name: step.name,
          description: step.description,
          tags: step.tags,
          sessionId,
          nodeId: on.id,
          shared: false,
          createdAt: step.createdAt,
        });
        yield* events.record({
          kind: "snapshot.taken",
          resource: { kind: "snapshot", id: kept.id, label: kept.name },
          ownerId: kept.accountId,
          workspaceId: kept.workspaceId,
          detail: { from: FROM },
        });
        return kept.id;
      }
      case "token": {
        const account = yield* made(step.account);
        const held =
          step.snapshots === null
            ? undefined
            : resourcesOf(
                yield* Effect.forEach(step.snapshots, (snapshot) =>
                  made(key("snapshot", snapshot)),
                ),
              );
        const lasts =
          step.expiresAt === null
            ? undefined
            : Duration.millis(Math.max(1, step.expiresAt.getTime() - (yield* now).getTime()));
        const { token, secret } = yield* accounts
          .createToken(account, step.name, lasts, step.scopes, held)
          .pipe(Effect.mapError((error) => failed(error.message)));
        const owner = yield* accountsStore.find(account);
        yield* secrets.keep({
          v1Id: step.v1Id,
          id: token.id,
          account: Option.match(owner, { onNone: () => account, onSome: (found) => found.name }),
          name: token.name,
          secret,
        });
        return token.id;
      }
    }
  });

  const apply = Effect.fn("Migrator.apply")(function* () {
    const todo = yield* plan();
    if (todo.conflicts.length > 0) {
      return yield* new NotMappable({ conflicts: todo.conflicts.length });
    }
    if (todo.steps.length === 0) {
      return todo;
    }
    yield* moved.prepare();
    const ids = new Map(yield* moved.all());
    for (const step of todo.steps) {
      // A step and the record of it are kept together or not at all.
      const v2Id = yield* Effect.gen(function* () {
        const made = yield* take(step, ids);
        yield* moved.record({ key: key(step.kind, step.v1Id), v2Id: made, at: yield* now });
        return made;
      }).pipe(sql.withTransaction, Effect.catchTag("SqlError", Effect.die));
      ids.set(key(step.kind, step.v1Id), v2Id);
    }
    return todo;
  });

  return Migrator.of({ plan, apply });
});

export const layer = (options: Options) => Layer.effect(Migrator, makeMigrator(options));
