import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Memory, moment, ordered } from "../store/memory.ts";
import type { Snapshot } from "./schemas.ts";
import { type NewSnapshot, SnapshotsStore } from "./store.ts";

/** The records of snapshots kept in memory. */
export const makeSnapshotsStoreMemory = Effect.fn("SnapshotsStore.makeMemory")(function* () {
  const memory = yield* Memory;

  const created = () => ordered(memory.snapshots.values(), (snapshot) => snapshot.createdAt);

  const insert = Effect.fn("SnapshotsStore.insert")((snapshot: NewSnapshot) =>
    Effect.sync(() => {
      const kept: Snapshot = { ...snapshot, createdAt: moment(snapshot.createdAt) };
      memory.snapshots.set(kept.id, kept);
      return kept;
    }),
  );

  const find = Effect.fn("SnapshotsStore.find")((id: string) =>
    Effect.sync(() => Option.fromUndefinedOr(memory.snapshots.get(id))),
  );

  const list = Effect.fn("SnapshotsStore.list")(() => Effect.sync(created));

  const listOf = Effect.fn("SnapshotsStore.listOf")((accountId: string) =>
    Effect.sync(() => created().filter((snapshot) => snapshot.accountId === accountId)),
  );

  const delete_ = Effect.fn("SnapshotsStore.delete")((id: string) =>
    Effect.sync(() => {
      memory.snapshots.delete(id);
    }),
  );

  return SnapshotsStore.of({ insert, find, list, listOf, delete: delete_ });
});

export const layerTest = Layer.effect(SnapshotsStore, makeSnapshotsStoreMemory());
