import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { asked } from "../nodes/asked.ts";
import type { Node } from "../nodes/schemas.ts";
import { Nodes } from "../nodes/service.ts";
import type { Session } from "../sessions/schemas.ts";
import { Sessions } from "../sessions/service.ts";
import { SessionsStore } from "../sessions/store.ts";
import { ago, now } from "../time.ts";
import { holds, limitsOf } from "./limits.ts";
import { type Effective, Policy } from "./service.ts";
import { PolicyStore } from "./store.ts";

/** How often sessions are looked at for what their settings say becomes of them. */
const LOOK_EVERY = Duration.minutes(1);
/** How often what was deleted long enough ago is removed for good. */
const PURGE_EVERY = Duration.hours(1);
/** How long changes are let gather before the sessions are looked at for them. */
const CHANGES_GATHER = Duration.seconds(1);

const placeOf = (session: Session) => ({
  workspaceId: session.workspaceId,
  accountId: session.accountId,
  sessionId: session.id,
});

/** Why a session is to be deleted by itself, as its settings say; none for one that stays. */
const dueFor = (session: Session, effective: Effective, at: number) => {
  // A pinned session is never deleted but by someone.
  if (session.pinned) {
    return undefined;
  }
  const age = effective.maxSessionAge.value;
  if (typeof age === "number" && DateTime.toEpochMillis(session.createdAt) + age * 1000 <= at) {
    return `it was older than the ${effective.maxSessionAge.source} lets a session be`;
  }
  const suspended = effective.deleteSuspendedAfter.value;
  if (
    typeof suspended === "number" &&
    session.suspendedSince !== null &&
    DateTime.toEpochMillis(session.suspendedSince) + suspended * 1000 <= at
  ) {
    return `it stayed suspended longer than the ${effective.deleteSuspendedAfter.source} lets a session`;
  }
  return undefined;
};

/**
 * For as long as the scope lasts: deletes the sessions their settings say are to go, has
 * each node hold its sessions to the limits their settings say, and removes for good what
 * was deleted long enough ago. Each is done again a while after, and the limits at once
 * when a setting changes.
 */
export const makeLifecycle = Effect.fn("Lifecycle.make")(function* () {
  const policy = yield* Policy;
  const sessions = yield* Sessions;
  const records = yield* SessionsStore;
  const nodes = yield* Nodes;
  const store = yield* PolicyStore;

  const expire = Effect.fn("Lifecycle.expire")(function* () {
    const effectiveOf = yield* policy.snapshot();
    const at = (yield* now).getTime();
    const all = yield* records.list();
    yield* Effect.forEach(
      all,
      (session) => {
        const due = dueFor(session, effectiveOf(placeOf(session)), at);
        return due === undefined
          ? Effect.void
          : sessions
              .expire(session.id, due)
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning(`session ${session.id} was not deleted`, cause),
                ),
              );
      },
      { discard: true },
    );
  });

  const limit = Effect.fn("Lifecycle.limit")(function* () {
    const effectiveOf = yield* policy.snapshot();
    const recorded = new Map((yield* records.list()).map((session) => [session.id, session]));
    const onNode = Effect.fn(function* (node: Node) {
      const executor = nodes.executor(node);
      const there = yield* executor.sessions.list.pipe(asked(node));
      yield* Effect.forEach(
        there,
        (told) => {
          const session = recorded.get(told.id);
          if (session === undefined || session.nodeId !== node.id) {
            return Effect.void;
          }
          const wanted = limitsOf(
            effectiveOf(placeOf(session)),
            session.pinned,
            node.offers?.holdsResources === true,
          );
          return holds(told.limits, wanted, node.offers?.limits)
            ? Effect.void
            : executor.sessions.setLimits(told.id, wanted).pipe(asked(node));
        },
        { discard: true },
      );
    });
    yield* Effect.forEach(
      yield* nodes.alive(),
      (node) =>
        onNode(node).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `the sessions of node ${node.name} were not held to their limits`,
              cause,
            ),
          ),
        ),
      { discard: true },
    );
  });

  const purge = Effect.fn("Lifecycle.purge")(function* () {
    const { purgeDeletedAfter } = (yield* policy.snapshot())({
      workspaceId: null,
      accountId: null,
      sessionId: null,
    });
    if (typeof purgeDeletedAfter.value === "number") {
      yield* store.purge(yield* ago(Duration.seconds(purgeDeletedAfter.value)));
    }
  });

  const looked = (what: string, effect: Effect.Effect<void>) =>
    effect.pipe(Effect.catchCause((cause) => Effect.logError(what, cause)));

  yield* Effect.andThen(
    looked("the sessions' settings were not looked after", expire()),
    looked("the sessions' limits were not looked after", limit()),
  ).pipe(Effect.repeat(Schedule.spaced(LOOK_EVERY)), Effect.forkScoped);
  yield* looked("what was deleted was not purged", purge()).pipe(
    Effect.repeat(Schedule.spaced(PURGE_EVERY)),
    Effect.forkScoped,
  );
  yield* policy.changes.pipe(
    Stream.debounce(CHANGES_GATHER),
    Stream.runForEach(() => looked("the sessions' limits were not looked after", limit())),
    Effect.forkScoped,
  );
});

export const layer = Layer.effectDiscard(makeLifecycle());
