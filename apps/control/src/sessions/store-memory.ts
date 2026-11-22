import type { DesiredState } from "@aperture-browser/control-api";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Memory, moment, ordered } from "../store/memory.ts";
import type { Observation, Session } from "./schemas.ts";
import { type NewSession, type SessionDescription, SessionsStore } from "./store.ts";

/** The records of sessions kept in memory. */
export const makeSessionsStoreMemory = Effect.fn("SessionsStore.makeMemory")(function* () {
  const memory = yield* Memory;

  const created = () => ordered(memory.sessions.values(), (session) => session.createdAt);

  /** Writes the sessions that are chosen anew, each as it is changed. */
  const change = (chosen: (session: Session) => boolean, changed: (session: Session) => Session) =>
    Effect.sync(() => {
      for (const session of memory.sessions.values()) {
        if (chosen(session)) {
          memory.sessions.set(session.id, changed(session));
        }
      }
    });

  const insert = Effect.fn("SessionsStore.insert")((session: NewSession) =>
    Effect.sync(() => {
      // What a database refuses by itself is refused here by hand.
      if (session.accountId === null && session.workspaceId === null) {
        throw new Error(`session ${session.id} is of no workspace and of no account`);
      }
      const kept: Session = {
        id: session.id,
        accountId: session.accountId,
        workspaceId: session.workspaceId,
        nodeId: session.nodeId,
        desiredState: session.desiredState,
        observedState: session.observedState,
        failure: session.failure,
        unreachableSince: null,
        snapshotId: session.snapshotId,
        label: session.label,
        tags: session.tags,
        createdAt: moment(session.createdAt),
        observedAt: moment(session.now),
      };
      memory.sessions.set(kept.id, kept);
      return kept;
    }),
  );

  const find = Effect.fn("SessionsStore.find")((id: string) =>
    Effect.sync(() => Option.fromUndefinedOr(memory.sessions.get(id))),
  );

  const list = Effect.fn("SessionsStore.list")(() => Effect.sync(created));

  const listOf = Effect.fn("SessionsStore.listOf")(
    (accountId: string, workspaceIds: ReadonlyArray<string>) =>
      Effect.sync(() =>
        created().filter((session) =>
          session.workspaceId === null
            ? session.accountId === accountId
            : workspaceIds.includes(session.workspaceId),
        ),
      ),
  );

  const on = Effect.fn("SessionsStore.on")((nodeId: string) =>
    Effect.sync(() =>
      [...memory.sessions.values()]
        .filter((session) => session.nodeId === nodeId)
        .map((session) => session.id),
    ),
  );

  const describe = Effect.fn("SessionsStore.describe")((id: string, said: SessionDescription) =>
    change(
      (session) => session.id === id,
      (session) => ({
        ...session,
        label: said.label === undefined ? session.label : said.label,
        tags: said.tags ?? session.tags,
      }),
    ),
  );

  const proxyOf = Effect.fn("SessionsStore.proxyOf")((id: string) =>
    Effect.sync(() => Option.fromUndefinedOr(memory.sessionProxies.get(id))),
  );

  const keepProxy = Effect.fn("SessionsStore.keepProxy")((id: string, sealed: string | null) =>
    Effect.sync(() => {
      if (sealed === null) {
        memory.sessionProxies.delete(id);
      } else {
        memory.sessionProxies.set(id, sealed);
      }
    }),
  );

  const desire = Effect.fn("SessionsStore.desire")((id: string, state: DesiredState) =>
    change(
      (session) => session.id === id,
      (session) => ({ ...session, desiredState: state }),
    ),
  );

  const delete_ = Effect.fn("SessionsStore.delete")((id: string) =>
    Effect.sync(() => {
      memory.sessions.delete(id);
      memory.sessionProxies.delete(id);
      // Its share links go with it, as the database has them go.
      for (const [hash, share] of memory.shares) {
        if (share.sessionId === id) {
          memory.shares.delete(hash);
        }
      }
    }),
  );

  const observe = Effect.fn("SessionsStore.observe")(
    (nodeId: string, seen: Observation, now: Date) =>
      change(
        (session) => session.id === seen.id && session.nodeId === nodeId,
        (session) => ({
          ...session,
          observedState: seen.state,
          failure: seen.failure,
          unreachableSince: null,
          observedAt: moment(now),
        }),
      ),
  );

  const gone = Effect.fn("SessionsStore.gone")((nodeId: string, id: string, now: Date) =>
    change(
      (session) => session.id === id && session.nodeId === nodeId,
      (session) => ({
        ...session,
        nodeId: null,
        observedState: "gone",
        unreachableSince: null,
        observedAt: moment(now),
      }),
    ),
  );

  const unreachable = Effect.fn("SessionsStore.unreachable")((nodeId: string, now: Date) =>
    change(
      (session) => session.nodeId === nodeId && session.unreachableSince === null,
      (session) => ({ ...session, unreachableSince: moment(now) }),
    ),
  );

  const unreachableExceptOn = Effect.fn("SessionsStore.unreachableExceptOn")(
    (nodeIds: ReadonlyArray<string>, now: Date) =>
      change(
        (session) =>
          session.nodeId !== null &&
          session.unreachableSince === null &&
          !nodeIds.includes(session.nodeId),
        (session) => ({ ...session, unreachableSince: moment(now) }),
      ),
  );

  return SessionsStore.of({
    insert,
    find,
    list,
    listOf,
    on,
    describe,
    proxyOf,
    keepProxy,
    desire,
    delete: delete_,
    observe,
    gone,
    unreachable,
    unreachableExceptOn,
  });
});

export const layerTest = Layer.effect(SessionsStore, makeSessionsStoreMemory());
