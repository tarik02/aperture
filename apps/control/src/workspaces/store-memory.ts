import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Memory, moment, ordered } from "../store/memory.ts";
import type { Workspace, WorkspaceRole } from "./schemas.ts";
import { type NewWorkspace, WorkspacesStore } from "./store.ts";

/** Workspaces kept in memory. */
export const makeWorkspacesStoreMemory = Effect.fn("WorkspacesStore.makeMemory")(function* () {
  const memory = yield* Memory;

  const created = () => ordered(memory.workspaces.values(), (workspace) => workspace.createdAt);
  const membersOf = (id: string) =>
    memory.workspaceMembers.get(id) ?? new Map<string, WorkspaceRole>();

  const insert = Effect.fn("WorkspacesStore.insert")((workspace: NewWorkspace) =>
    Effect.sync(() => {
      const kept: Workspace = { ...workspace, createdAt: moment(workspace.createdAt) };
      memory.workspaces.set(kept.id, kept);
      return kept;
    }),
  );

  const find = Effect.fn("WorkspacesStore.find")((id: string) =>
    Effect.sync(() => Option.fromUndefinedOr(memory.workspaces.get(id))),
  );

  const list = Effect.fn("WorkspacesStore.list")(() => Effect.sync(created));

  const of = Effect.fn("WorkspacesStore.of")((accountId: string) =>
    Effect.sync(() =>
      created().flatMap((workspace) => {
        const role = membersOf(workspace.id).get(accountId);
        return role === undefined ? [] : [{ workspace, role }];
      }),
    ),
  );

  const rename = Effect.fn("WorkspacesStore.rename")((id: string, name: string) =>
    Effect.sync(() => {
      const workspace = memory.workspaces.get(id);
      if (workspace !== undefined) {
        memory.workspaces.set(id, { ...workspace, name });
      }
    }),
  );

  const delete_ = Effect.fn("WorkspacesStore.delete")((id: string) =>
    Effect.sync(() => {
      const used =
        [...memory.sessions.values()].some((session) => session.workspaceId === id) ||
        [...memory.snapshots.values()].some((snapshot) => snapshot.workspaceId === id);
      if (used) {
        return false;
      }
      memory.workspaces.delete(id);
      memory.workspaceMembers.delete(id);
      return true;
    }),
  );

  const members = Effect.fn("WorkspacesStore.members")((id: string) =>
    Effect.sync(() =>
      ordered(memory.accounts.values(), (account) => account.createdAt).flatMap((account) => {
        const role = membersOf(id).get(account.id);
        return role === undefined
          ? []
          : [
              {
                accountId: account.id,
                name: account.name,
                kind: account.kind,
                email: account.email,
                role,
              },
            ];
      }),
    ),
  );

  const admit = Effect.fn("WorkspacesStore.admit")(
    (id: string, accountId: string, role: WorkspaceRole) =>
      Effect.sync(() => {
        memory.workspaceMembers.set(id, new Map(membersOf(id)).set(accountId, role));
      }),
  );

  const dismiss = Effect.fn("WorkspacesStore.dismiss")((id: string, accountId: string) =>
    Effect.sync(() => {
      const left = new Map(membersOf(id));
      left.delete(accountId);
      memory.workspaceMembers.set(id, left);
    }),
  );

  return WorkspacesStore.of({
    insert,
    find,
    list,
    of,
    rename,
    delete: delete_,
    members,
    admit,
    dismiss,
  });
});

export const layerTest = Layer.effect(WorkspacesStore, makeWorkspacesStoreMemory());
