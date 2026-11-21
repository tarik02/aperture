import type { Caller } from "@aperture-browser/control-api";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { accountOf } from "../accounts/caller.ts";
import { AccountsStore } from "../accounts/store.ts";
import { AccountNotFound, Forbidden, WorkspaceInUse, WorkspaceNotFound } from "../errors.ts";
import { Events } from "../events/service.ts";
import * as Secrets from "../secrets.ts";
import { now } from "../time.ts";
import type { Workspace, WorkspaceRole } from "./schemas.ts";
import { type Joined, Workspaces } from "./service.ts";
import { WorkspacesStore } from "./store.ts";

export const makeWorkspaces = Effect.fn("Workspaces.make")(function* () {
  const store = yield* WorkspacesStore;
  const accounts = yield* AccountsStore;
  const events = yield* Events;
  const crypto = yield* Effect.context<Crypto.Crypto>();

  /** A workspace as an event is about it. */
  const about = (workspace: Workspace) =>
    ({
      resource: { kind: "workspace", id: workspace.id, label: workspace.name },
      workspaceId: workspace.id,
    }) as const;

  /** The workspace as the caller has it; one the caller is not in is not there for them. */
  const joined = Effect.fn(function* (caller: Caller, id: string) {
    const workspace = yield* store.find(id);
    const role = caller.workspaces.find((one) => one.id === id)?.role ?? null;
    if (Option.isNone(workspace) || (role === null && !caller.admin)) {
      return yield* new WorkspaceNotFound({ id });
    }
    return { workspace: workspace.value, role } satisfies Joined;
  });

  /** Goes on for whoever says who is in the workspace: its admins, and the system's. */
  const administered = Effect.fn(function* (caller: Caller, id: string) {
    const found = yield* joined(caller, id);
    if (found.role !== "admin" && !caller.admin) {
      return yield* new Forbidden({ message: "this is for an admin of the workspace to do" });
    }
    return found;
  });

  const create = Effect.fn("Workspaces.create")(function* (caller: Caller, name: string) {
    const account = yield* accountOf(caller);
    const workspace = yield* store.insert({ id: yield* Secrets.id, name, createdAt: yield* now });
    yield* store.admit(workspace.id, account.id, "admin");
    yield* events.record({ kind: "workspace.created", ...about(workspace) });
    return { workspace, role: "admin" } satisfies Joined;
  }, Effect.provide(crypto));

  const list = Effect.fn("Workspaces.list")(function* (caller: Caller) {
    const mine = Option.isNone(caller.account) ? [] : yield* store.of(caller.account.value.id);
    if (!caller.admin) {
      return mine satisfies ReadonlyArray<Joined>;
    }
    const all = yield* store.list();
    return all.map(
      (workspace): Joined => ({
        workspace,
        role: mine.find((one) => one.workspace.id === workspace.id)?.role ?? null,
      }),
    );
  });

  const of = Effect.fn("Workspaces.of")(function* (accountId: string) {
    return yield* store.of(accountId);
  });

  const rename = Effect.fn("Workspaces.rename")(function* (
    caller: Caller,
    id: string,
    name: string,
  ) {
    const found = yield* administered(caller, id);
    yield* store.rename(id, name);
    yield* events.record({
      kind: "workspace.renamed",
      ...about({ ...found.workspace, name }),
      detail: { from: found.workspace.name },
    });
    return { ...found, workspace: { ...found.workspace, name } } satisfies Joined;
  });

  const delete_ = Effect.fn("Workspaces.delete")(function* (caller: Caller, id: string) {
    const found = yield* administered(caller, id);
    if (!(yield* store.delete(id))) {
      return yield* new WorkspaceInUse({ id });
    }
    yield* events.record({ kind: "workspace.deleted", ...about(found.workspace) });
  });

  const members = Effect.fn("Workspaces.members")(function* (caller: Caller, id: string) {
    yield* joined(caller, id);
    return yield* store.members(id);
  });

  const admit = Effect.fn("Workspaces.admit")(function* (
    caller: Caller,
    id: string,
    accountId: string,
    role: WorkspaceRole,
  ) {
    const found = yield* administered(caller, id);
    const account = yield* accounts.find(accountId);
    if (Option.isNone(account)) {
      return yield* new AccountNotFound({ id: accountId });
    }
    yield* store.admit(id, accountId, role);
    yield* events.record({
      kind: "workspace.member_admitted",
      ...about(found.workspace),
      ownerId: accountId,
      detail: { accountId, account: account.value.name, role },
    });
  });

  const dismiss = Effect.fn("Workspaces.dismiss")(function* (
    caller: Caller,
    id: string,
    accountId: string,
  ) {
    const found = yield* administered(caller, id);
    const account = yield* accounts.find(accountId);
    yield* store.dismiss(id, accountId);
    yield* events.record({
      kind: "workspace.member_dismissed",
      ...about(found.workspace),
      ownerId: accountId,
      detail: {
        accountId,
        account: Option.getOrNull(Option.map(account, (one) => one.name)),
      },
    });
  });

  return Workspaces.of({ create, list, of, rename, delete: delete_, members, admit, dismiss });
});

export const layer = Layer.effect(Workspaces, makeWorkspaces());
