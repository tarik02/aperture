import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { reaches } from "../accounts/caller.ts";
import type { Caller } from "../accounts/schemas.ts";
import { SnapshotNotFound } from "../errors.ts";
import { asked } from "../nodes/asked.ts";
import type { Node } from "../nodes/schemas.ts";
import { Nodes } from "../nodes/service.ts";
import { Sessions } from "../sessions/service.ts";
import { now } from "../time.ts";
import type { Snapshot } from "./schemas.ts";
import { Snapshots } from "./service.ts";
import { SnapshotsStore } from "./store.ts";

export const makeSnapshots = Effect.fn("Snapshots.make")(function* () {
  const store = yield* SnapshotsStore;
  const nodes = yield* Nodes;
  const sessions = yield* Sessions;

  const owned = Effect.fn(function* (caller: Caller, id: string) {
    const snapshot = yield* store.find(id);
    return yield* Option.match(
      Option.filter(snapshot, (found) => reaches(caller, found.accountId)),
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

  const take = Effect.fn("Snapshots.take")(function* (
    caller: Caller,
    sessionId: string,
    options: { readonly name: string | undefined },
  ) {
    const { session, node } = yield* sessions.placed(caller, sessionId);
    const taken = yield* nodes
      .executor(node)
      .snapshots.create({ sessionId, name: options.name })
      .pipe(asked(node));
    const created = taken.createdAt;
    return yield* store.insert({
      id: taken.id,
      // A snapshot is whose the session is, also when an admin takes it.
      accountId: session.accountId,
      name: taken.name ?? null,
      sessionId,
      nodeId: node.id,
      shared: node.offers?.sharesSnapshots === true,
      createdAt: created === undefined ? yield* now : new Date(Number(created.seconds) * 1000),
    });
  });

  const list = Effect.fn("Snapshots.list")(function* (caller: Caller) {
    if (caller.admin) {
      return yield* store.list();
    }
    return yield* Option.match(caller.account, {
      onSome: (account) => store.listOf(account.id),
      onNone: () => Effect.succeed([]),
    });
  });

  const get = Effect.fn("Snapshots.get")(function* (caller: Caller, id: string) {
    return yield* owned(caller, id);
  });

  const delete_ = Effect.fn("Snapshots.delete")(function* (caller: Caller, id: string) {
    const snapshot = yield* owned(caller, id);
    const node = yield* holder(snapshot);
    if (Option.isSome(node)) {
      yield* nodes
        .executor(node.value)
        .snapshots.delete(id)
        .pipe(
          // A snapshot its node has no more is deleted there already.
          Effect.catchIf(
            (error) => error.code === "not_found",
            () => Effect.void,
          ),
          asked(node.value),
        );
    }
    yield* store.delete(id);
  });

  return Snapshots.of({ take, list, get, delete: delete_ });
});

export const layer = Layer.effect(Snapshots, makeSnapshots());
