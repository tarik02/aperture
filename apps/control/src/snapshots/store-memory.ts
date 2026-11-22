import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Memory, moment, ordered } from "../store/memory.ts";
import type { Snapshot } from "./schemas.ts";
import { type NewSnapshot, type SnapshotDescription, SnapshotsStore } from "./store.ts";

/** The records of snapshots kept in memory. */
export const makeSnapshotsStoreMemory = Effect.fn("SnapshotsStore.makeMemory")(function* () {
  const memory = yield* Memory;

  const created = () => ordered(memory.snapshots.values(), (snapshot) => snapshot.createdAt);

  const insert = Effect.fn("SnapshotsStore.insert")((snapshot: NewSnapshot) =>
    Effect.sync(() => {
      // What a database refuses by itself is refused here by hand.
      if (snapshot.accountId === null && snapshot.workspaceId === null) {
        throw new Error(`snapshot ${snapshot.id} is of no workspace and of no account`);
      }
      const kept: Snapshot = { ...snapshot, createdAt: moment(snapshot.createdAt) };
      memory.snapshots.set(kept.id, kept);
      return kept;
    }),
  );

  const find = Effect.fn("SnapshotsStore.find")((id: string) =>
    Effect.sync(() => Option.fromUndefinedOr(memory.snapshots.get(id))),
  );

  const list = Effect.fn("SnapshotsStore.list")(() => Effect.sync(created));

  const listOf = Effect.fn("SnapshotsStore.listOf")(
    (accountId: string, workspaceIds: ReadonlyArray<string>) =>
      Effect.sync(() =>
        created().filter((snapshot) =>
          snapshot.workspaceId === null
            ? snapshot.accountId === accountId
            : workspaceIds.includes(snapshot.workspaceId),
        ),
      ),
  );

  const describe = Effect.fn("SnapshotsStore.describe")((id: string, said: SnapshotDescription) =>
    Effect.sync(() => {
      const snapshot = memory.snapshots.get(id);
      if (snapshot !== undefined) {
        memory.snapshots.set(id, {
          ...snapshot,
          name: said.name === undefined ? snapshot.name : said.name,
          description: said.description === undefined ? snapshot.description : said.description,
          tags: said.tags ?? snapshot.tags,
        });
      }
    }),
  );

  const delete_ = Effect.fn("SnapshotsStore.delete")((id: string) =>
    Effect.sync(() => {
      memory.snapshots.delete(id);
    }),
  );

  return SnapshotsStore.of({ insert, find, list, listOf, describe, delete: delete_ });
});

export const layerTest = Layer.effect(SnapshotsStore, makeSnapshotsStoreMemory());
