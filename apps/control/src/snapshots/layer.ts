import type { Caller } from "@aperture-browser/control-api";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { reaches } from "../accounts/caller.ts";
import { SnapshotNotFound } from "../errors.ts";
import { asked } from "../nodes/asked.ts";
import type { Node } from "../nodes/schemas.ts";
import { Nodes } from "../nodes/service.ts";
import { Sessions } from "../sessions/service.ts";
import { now } from "../time.ts";
import type { Snapshot } from "./schemas.ts";
import { Snapshots, type TakeOptions } from "./service.ts";
import { type SnapshotDescription, SnapshotsStore } from "./store.ts";

export const makeSnapshots = Effect.fn("Snapshots.make")(function* () {
  const store = yield* SnapshotsStore;
  const nodes = yield* Nodes;
  const sessions = yield* Sessions;

  const owned = Effect.fn(function* (caller: Caller, id: string) {
    const snapshot = yield* store.find(id);
    return yield* Option.match(
      Option.filter(snapshot, (found) =>
        reaches(caller, found, { kind: "snapshots", id: found.id }),
      ),
      {
        onNone: () => Effect.fail(new SnapshotNotFound({ id })),
        onSome: Effect.succeed,
      },
    );
  });

  /** A node that has the snapshot: the one it was taken on, or another that finds it. */
  const holder = Effect.fn(function* (snapshot: Snapshot) {
    const own = snapshot.nodeId === null ? Option.none<Node>() : yield* nodes.find(snapshot.nodeId);
    if (Option.isSome(own) || !snapshot.shared) {
      return own;
    }
    const alive = yield* nodes.alive();
    return Option.fromUndefinedOr(alive.find((node) => node.offers?.sharesSnapshots === true));
  });

  /** Deletes a snapshot where it is kept, and its record. */
  const remove = Effect.fn(function* (snapshot: Snapshot) {
    const node = yield* holder(snapshot);
    if (Option.isSome(node)) {
      yield* nodes
        .executor(node.value)
        .snapshots.delete(snapshot.id)
        .pipe(
          // A snapshot its node has no more is deleted there already.
          Effect.catchIf(
            (error) => error.code === "not_found",
            () => Effect.void,
          ),
          asked(node.value),
        );
    }
    yield* store.delete(snapshot.id);
  });

  const take = Effect.fn("Snapshots.take")(function* (
    caller: Caller,
    sessionId: string,
    options: TakeOptions,
  ) {
    const { session, node } = yield* sessions.placed(caller, sessionId);
    const replaced =
      options.replaces === undefined ? undefined : yield* owned(caller, options.replaces);
    const name = options.name ?? replaced?.name ?? undefined;
    const taken = yield* nodes
      .executor(node)
      .snapshots.create({ sessionId, name })
      .pipe(asked(node));
    const created = taken.createdAt;
    const kept = yield* store.insert({
      id: taken.id,
      // A snapshot is whose the session is, also when an admin takes it.
      accountId: session.accountId,
      workspaceId: session.workspaceId,
      name: taken.name ?? null,
      description: options.description ?? replaced?.description ?? null,
      tags: options.tags ?? replaced?.tags ?? {},
      sessionId,
      nodeId: node.id,
      shared: node.offers?.sharesSnapshots === true,
      createdAt: created === undefined ? yield* now : new Date(Number(created.seconds) * 1000),
    });
    // Only once the new one is there: a snapshot that could not be taken replaces nothing.
    if (replaced !== undefined) {
      yield* remove(replaced);
    }
    return kept;
  });

  const list = Effect.fn("Snapshots.list")(function* (caller: Caller) {
    const all = caller.admin
      ? yield* store.list()
      : yield* Option.match(caller.account, {
          onSome: (account) =>
            store.listOf(
              account.id,
              caller.workspaces.map((workspace) => workspace.id),
            ),
          onNone: () => Effect.succeed([]),
        });
    return all.filter((snapshot) =>
      reaches(caller, snapshot, { kind: "snapshots", id: snapshot.id }),
    );
  });

  const get = Effect.fn("Snapshots.get")(function* (caller: Caller, id: string) {
    return yield* owned(caller, id);
  });

  const describe = Effect.fn("Snapshots.describe")(function* (
    caller: Caller,
    id: string,
    said: SnapshotDescription,
  ) {
    yield* owned(caller, id);
    yield* store.describe(id, said);
    return yield* owned(caller, id);
  });

  const delete_ = Effect.fn("Snapshots.delete")(function* (caller: Caller, id: string) {
    yield* remove(yield* owned(caller, id));
  });

  return Snapshots.of({ take, list, get, describe, delete: delete_ });
});

export const layer = Layer.effect(Snapshots, makeSnapshots());
