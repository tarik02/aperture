import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type { Node } from "./nodes/schemas.ts";
import { Nodes } from "./nodes/service.ts";
import { Sessions } from "./sessions/service.ts";
import { keepaliveEvery, Settings } from "./settings/service.ts";

/** How long a node that did not answer is left alone before it is asked again. */
const AGAIN_AFTER = "1 second";
/** How often a node's sessions are compared with their records, beside what it tells. */
const RECONCILE_EVERY = "5 seconds";
/** How often the nodes are looked at at least, so that a new one is soon followed. */
const LOOK_EVERY = Duration.seconds(2);

// A node that comes back at another address, or with another token, is followed anew.
const key = (node: Node) => [node.id, node.internalUrl, node.operatorToken].join("\n");

/**
 * Follows the nodes that are alive, for as long as the scope lasts: what each says of its
 * sessions is written into their records. The sessions of a node that falls silent or
 * does not answer are marked as out of reach, and stay as they were last seen.
 */
export const makeFollowing = Effect.fn("Following.make")(function* () {
  const nodes = yield* Nodes;
  const sessions = yield* Sessions;
  const settings = yield* Settings;
  const followed = yield* FiberMap.make<string>();

  const hear = Effect.fn("Following.hear")(function* (node: Node) {
    const executor = nodes.executor(node);
    yield* nodes.describe(node, yield* executor.get);
    yield* sessions.reconcile(node);
    const watched = executor.sessions.watch.pipe(
      Stream.runForEach((heard) =>
        heard.event.case === "session"
          ? sessions.heard(node, heard.event.value)
          : heard.event.case === "gone"
            ? sessions.gone(node, heard.event.value)
            : Effect.void,
      ),
    );
    // A node tells what it sees when it looks, so a session that came and went
    // between two looks is never told of, nor told gone: the records are brought
    // to what the node has every so often as well.
    const reconciled = sessions.reconcile(node).pipe(Effect.delay(RECONCILE_EVERY), Effect.forever);
    yield* Effect.raceFirst(watched, reconciled);
  });

  const follow = Effect.fn("Following.follow")(function* (node: Node) {
    yield* hear(node).pipe(
      Effect.catchCause((cause) => Effect.logWarning(`node ${node.name} is not followed`, cause)),
      // A stream that ends says as much as one that fails: the node is not heard.
      Effect.andThen(sessions.unreachable(node)),
      Effect.repeat(Schedule.spaced(AGAIN_AFTER)),
    );
  });

  const look = Effect.fn("Following.look")(function* () {
    const alive = yield* nodes.alive();
    const keys = new Set(alive.map(key));
    for (const [followedKey] of followed) {
      if (!keys.has(followedKey)) {
        yield* FiberMap.remove(followed, followedKey);
      }
    }
    yield* Effect.forEach(
      alive,
      (node) => FiberMap.run(followed, key(node), follow(node), { onlyIfMissing: true }),
      { discard: true },
    );
    yield* sessions.unreachableExceptOn(alive);
    yield* nodes.noteSilent();
  });

  yield* look().pipe(
    Effect.catchCause((cause) => Effect.logError("the nodes could not be looked at", cause)),
    Effect.repeat(Schedule.spaced(Duration.min(keepaliveEvery(settings), LOOK_EVERY))),
    Effect.forkScoped,
  );
});

export const layer = Layer.effectDiscard(makeFollowing());
