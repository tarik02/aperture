import { type ExecutorError, proto } from "@aperture-browser/executor-client";
import * as UrlPath from "@aperture-browser/shared/url-path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import type { Account, Caller } from "../accounts/schemas.ts";
import {
  Forbidden,
  NodeRefused,
  NodeUnreachable,
  NoNode,
  SessionHasNoNode,
  SessionNotFound,
} from "../errors.ts";
import type { Node } from "../nodes/schemas.ts";
import { Nodes } from "../nodes/service.ts";
import type { Access } from "../tickets/schemas.ts";
import { Tickets } from "../tickets/service.ts";
import { now } from "../time.ts";
import type { Admission, Observation, ObservedState } from "./schemas.ts";
import { Sessions } from "./service.ts";
import { SessionsStore } from "./store.ts";

const STATES: Record<proto.SessionState, ObservedState | undefined> = {
  [proto.SessionState.UNSPECIFIED]: undefined,
  [proto.SessionState.SUSPENDED]: "suspended",
  [proto.SessionState.STARTING]: "starting",
  [proto.SessionState.RUNNING]: "running",
  [proto.SessionState.SUSPENDING]: "suspending",
  [proto.SessionState.FAILED]: "failed",
};

/** What a node says of a session; nothing where it says a state this program does not know. */
const observationOf = (session: proto.Session): Observation | undefined => {
  const state = STATES[session.state];
  return state === undefined
    ? undefined
    : { id: session.id, state, failure: session.failure ?? null };
};

/** Codes that say the node was not there to answer, and not that it answered no. */
const NOT_THERE: ReadonlySet<string> = new Set(["unavailable", "deadline_exceeded", "unknown"]);

const asked =
  (node: Node) =>
  <A, R>(call: Effect.Effect<A, ExecutorError, R>) =>
    Effect.mapError(call, (error) =>
      NOT_THERE.has(error.code)
        ? new NodeUnreachable({ node: node.name, message: error.message })
        : new NodeRefused({ node: node.name, code: error.code, message: error.message }),
    );

const accountOf = (caller: Caller): Effect.Effect<Account, Forbidden> =>
  Option.match(caller.account, {
    onNone: () =>
      Effect.fail(
        new Forbidden({ message: "sessions are an account's, and this token is of none" }),
      ),
    onSome: Effect.succeed,
  });

export const makeSessions = Effect.fn("Sessions.make")(function* () {
  const store = yield* SessionsStore;
  const nodes = yield* Nodes;
  const tickets = yield* Tickets;

  // What a node says of a session comes two ways: in answer to a request made here,
  // and in the stream the node is followed by. One at a time for each node, and asked
  // again inside its turn, so that what is written last is what the node said last.
  const turns = new Map<string, Semaphore.Semaphore>();
  const inTurn = <A, E, R>(node: Node, effect: Effect.Effect<A, E, R>) => {
    const turn = turns.get(node.id) ?? Semaphore.makeUnsafe(1);
    turns.set(node.id, turn);
    return turn.withPermit(effect);
  };

  const observe = Effect.fn(function* (node: Node, session: proto.Session) {
    const seen = observationOf(session);
    if (seen !== undefined) {
      yield* store.observe(node.id, seen, yield* now);
    }
  });

  const refresh = (node: Node, id: string) =>
    inTurn(
      node,
      nodes
        .executor(node)
        .sessions.get(id)
        .pipe(
          Effect.flatMap((session) => observe(node, session)),
          Effect.catchIf(
            (error) => error.code === "not_found",
            () => Effect.flatMap(now, (at) => store.gone(node.id, id, at)),
          ),
        ),
    );

  const owned = Effect.fn(function* (caller: Caller, id: string) {
    const session = yield* store.find(id);
    const mine = Option.filter(
      session,
      (found) =>
        caller.admin || Option.exists(caller.account, (account) => account.id === found.accountId),
    );
    return yield* Option.match(mine, {
      onNone: () => Effect.fail(new SessionNotFound({ id })),
      onSome: Effect.succeed,
    });
  });

  const placed = Effect.fn(function* (caller: Caller, id: string) {
    const session = yield* owned(caller, id);
    const node = session.nodeId === null ? Option.none<Node>() : yield* nodes.find(session.nodeId);
    if (Option.isNone(node)) {
      return yield* new SessionHasNoNode({ id });
    }
    return { session, node: node.value };
  });

  const current = (id: string) =>
    store.find(id).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new SessionNotFound({ id })),
          onSome: Effect.succeed,
        }),
      ),
    );

  /** Asks the session's node, then reads again what the node says of the session. */
  const through = <A>(
    node: Node,
    id: string,
    call: Effect.Effect<A, ExecutorError>,
  ): Effect.Effect<void, NodeUnreachable | NodeRefused> =>
    call.pipe(Effect.andThen(refresh(node, id)), asked(node));

  const place = (
    candidates: ReadonlyArray<Node>,
    suspended: boolean,
  ): Effect.Effect<readonly [Node, proto.Session], NoNode | NodeRefused> => {
    const [node, ...rest] = candidates;
    if (node === undefined) {
      return Effect.fail(new NoNode({ message: "no node is there to run a session" }));
    }
    return nodes
      .executor(node)
      .sessions.create({ suspended })
      .pipe(
        asked(node),
        Effect.map((session) => [node, session] as const),
        Effect.catchTag("NodeUnreachable", (error) =>
          Effect.logWarning(`node ${node.name} did not take a session: ${error.message}`).pipe(
            Effect.andThen(place(rest, suspended)),
          ),
        ),
      );
  };

  const create = Effect.fn("Sessions.create")(function* (
    caller: Caller,
    options: { readonly suspended: boolean },
  ) {
    const account = yield* accountOf(caller);
    const [node, session] = yield* place(yield* nodes.candidates(), options.suspended);
    const created = session.createdAt;
    yield* store.insert({
      id: session.id,
      accountId: account.id,
      nodeId: node.id,
      desiredState: options.suspended ? "suspended" : "running",
      observedState: observationOf(session)?.state ?? "starting",
      failure: session.failure ?? null,
      snapshotId: session.snapshotId ?? null,
      createdAt: created === undefined ? yield* now : new Date(Number(created.seconds) * 1000),
      now: yield* now,
    });
    // What the node said of the session while there was no record of it was dropped.
    yield* Effect.ignore(refresh(node, session.id));
    return yield* Effect.orDie(current(session.id));
  });

  const list = Effect.fn("Sessions.list")(function* (caller: Caller) {
    if (caller.admin) {
      return yield* store.list();
    }
    return yield* Option.match(caller.account, {
      onSome: (account) => store.listOf(account.id),
      onNone: () => Effect.succeed([]),
    });
  });

  const get = Effect.fn("Sessions.get")(function* (caller: Caller, id: string) {
    return yield* owned(caller, id);
  });

  const suspend = Effect.fn("Sessions.suspend")(function* (caller: Caller, id: string) {
    const { node } = yield* placed(caller, id);
    yield* store.desire(id, "suspended");
    yield* through(node, id, nodes.executor(node).sessions.suspend(id));
    return yield* current(id);
  });

  const resume = Effect.fn("Sessions.resume")(function* (caller: Caller, id: string) {
    const { node } = yield* placed(caller, id);
    yield* store.desire(id, "running");
    yield* through(node, id, nodes.executor(node).sessions.resume(id));
    return yield* current(id);
  });

  const delete_ = Effect.fn("Sessions.delete")(function* (caller: Caller, id: string) {
    const { node } = yield* placed(caller, id);
    yield* nodes
      .executor(node)
      .sessions.delete(id)
      .pipe(
        // A session its node has no more is deleted there already.
        Effect.catchIf(
          (error) => error.code === "not_found",
          () => Effect.void,
        ),
        asked(node),
      );
    yield* store.delete(id);
  });

  const admit = Effect.fn("Sessions.admit")(function* (
    caller: Caller,
    id: string,
    options: { readonly name: string | undefined; readonly access: Access },
  ) {
    const account = yield* accountOf(caller);
    const { node } = yield* placed(caller, id);
    const issued = yield* tickets.issue({
      sessionId: id,
      subject: account.id,
      name: options.name ?? account.name,
      access: options.access,
    });
    return {
      ...issued,
      url:
        node.publicUrl === null
          ? null
          : UrlPath.make`${UrlPath.raw(node.publicUrl)}/sessions/${id}/?token=${issued.ticket}`,
    } satisfies Admission;
  });

  const heard = Effect.fn("Sessions.heard")(function* (node: Node, session: proto.Session) {
    yield* inTurn(node, observe(node, session));
  });

  const gone = Effect.fn("Sessions.gone")(function* (node: Node, id: string) {
    yield* inTurn(
      node,
      Effect.flatMap(now, (at) => store.gone(node.id, id, at)),
    );
  });

  const reconcile = Effect.fn("Sessions.reconcile")(function* (node: Node) {
    const there = yield* nodes.executor(node).sessions.list;
    yield* Effect.forEach(there, (session) => inTurn(node, observe(node, session)), {
      discard: true,
    });
    const told = new Set(there.map((session) => session.id));
    const recorded = yield* store.on(node.id);
    yield* Effect.forEach(
      recorded.filter((id) => !told.has(id)),
      (id) => refresh(node, id),
      { discard: true },
    );
  });

  const unreachable = Effect.fn("Sessions.unreachable")(function* (node: Node) {
    yield* store.unreachable(node.id, yield* now);
  });

  const unreachableExceptOn = Effect.fn("Sessions.unreachableExceptOn")(function* (
    alive: ReadonlyArray<Node>,
  ) {
    yield* store.unreachableExceptOn(
      alive.map((node) => node.id),
      yield* now,
    );
  });

  return Sessions.of({
    create,
    list,
    get,
    suspend,
    resume,
    delete: delete_,
    admit,
    heard,
    gone,
    reconcile,
    unreachable,
    unreachableExceptOn,
  });
});

export const layer = Layer.effect(Sessions, makeSessions());
