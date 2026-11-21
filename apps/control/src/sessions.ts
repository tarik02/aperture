import { type ExecutorError, proto } from "@aperture-browser/executor-client";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import type { Caller } from "./accounts.ts";
import {
  Forbidden,
  NodeRefused,
  NodeUnreachable,
  NoNode,
  SessionHasNoNode,
  SessionNotFound,
} from "./errors.ts";
import { Nodes } from "./nodes.ts";
import type { Account } from "./store/accounts.ts";
import type { Node } from "./store/nodes.ts";
import {
  type Observation,
  type ObservedState,
  type Session,
  SessionsStore,
} from "./store/sessions.ts";
import { type Access, Tickets } from "./tickets.ts";
import { now } from "./time.ts";

/** A ticket into a session, and where its holder goes with it. */
export interface Admission {
  readonly ticket: string;
  readonly expiresAt: DateTime.Utc;
  /** The session's workbench with the ticket in it; none where its node has no public address. */
  readonly url: string | null;
}

/** What asking a session's node for something may come to. */
export type NodeError = SessionNotFound | SessionHasNoNode | NodeUnreachable | NodeRefused;

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

export class Sessions extends Context.Service<
  Sessions,
  {
    /**
     * Creates a session for the caller's account on a node that is alive, the one with the
     * fewest sessions first, and the next where that one does not answer.
     */
    readonly create: (
      caller: Caller,
      options: { readonly suspended: boolean },
    ) => Effect.Effect<Session, Forbidden | NoNode | NodeRefused>;
    /** The caller's own sessions; all of them for an admin. */
    readonly list: (caller: Caller) => Effect.Effect<ReadonlyArray<Session>>;
    readonly get: (caller: Caller, id: string) => Effect.Effect<Session, SessionNotFound>;
    readonly suspend: (caller: Caller, id: string) => Effect.Effect<Session, NodeError>;
    readonly resume: (caller: Caller, id: string) => Effect.Effect<Session, NodeError>;
    readonly delete: (caller: Caller, id: string) => Effect.Effect<void, NodeError>;
    /** A ticket for the caller's account into the session. */
    readonly admit: (
      caller: Caller,
      id: string,
      options: { readonly name: string | undefined; readonly access: Access },
    ) => Effect.Effect<Admission, Forbidden | SessionNotFound | SessionHasNoNode>;
    /** Takes what a node's executor said of one of its sessions. */
    readonly heard: (node: Node, session: proto.Session) => Effect.Effect<void>;
    /** Takes a node's word that it has a session no more. */
    readonly gone: (node: Node, id: string) => Effect.Effect<void>;
    /**
     * Brings the records of a node's sessions to what the node has now: for when the
     * control plane begins to follow it, and missed what happened before.
     */
    readonly reconcile: (node: Node) => Effect.Effect<void, ExecutorError>;
    /** Marks the sessions of a node that does not answer. */
    readonly unreachable: (node: Node) => Effect.Effect<void>;
    /** Marks the sessions of every node but these: the ones that are alive. */
    readonly unreachableExceptOn: (alive: ReadonlyArray<Node>) => Effect.Effect<void>;
  }
>()("@aperture-browser/control/Sessions") {
  static readonly layer = Layer.effect(
    Sessions,
    Effect.gen(function* () {
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

      const observe = (node: Node, session: proto.Session) =>
        Effect.gen(function* () {
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

      const accountOf = (caller: Caller): Effect.Effect<Account, Forbidden> =>
        Option.match(caller.account, {
          onNone: () =>
            Effect.fail(
              new Forbidden({ message: "sessions are an account's, and this token is of none" }),
            ),
          onSome: Effect.succeed,
        });

      const owned = Effect.fn(function* (caller: Caller, id: string) {
        const session = yield* store.find(id);
        const mine = Option.filter(
          session,
          (found) =>
            caller.admin ||
            Option.exists(caller.account, (account) => account.id === found.accountId),
        );
        return yield* Option.match(mine, {
          onNone: () => Effect.fail(new SessionNotFound({ id })),
          onSome: Effect.succeed,
        });
      });

      const placed = Effect.fn(function* (caller: Caller, id: string) {
        const session = yield* owned(caller, id);
        const node =
          session.nodeId === null ? Option.none<Node>() : yield* nodes.find(session.nodeId);
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

      return Sessions.of({
        create: Effect.fn("Sessions.create")(function* (caller, options) {
          const account = yield* accountOf(caller);
          const [node, session] = yield* place(yield* nodes.candidates, options.suspended);
          const created = session.createdAt;
          yield* store.insert({
            id: session.id,
            accountId: account.id,
            nodeId: node.id,
            desiredState: options.suspended ? "suspended" : "running",
            observedState: observationOf(session)?.state ?? "starting",
            failure: session.failure ?? null,
            snapshotId: session.snapshotId ?? null,
            createdAt:
              created === undefined ? yield* now : new Date(Number(created.seconds) * 1000),
            now: yield* now,
          });
          // What the node said of the session while there was no record of it was dropped.
          yield* Effect.ignore(refresh(node, session.id));
          return yield* Effect.orDie(current(session.id));
        }),
        list: (caller) =>
          Option.match(caller.account, {
            onSome: (account) => (caller.admin ? store.list : store.listOf(account.id)),
            onNone: () => (caller.admin ? store.list : Effect.succeed([])),
          }),
        get: owned,
        suspend: Effect.fn("Sessions.suspend")(function* (caller, id) {
          const { node } = yield* placed(caller, id);
          yield* store.desire(id, "suspended");
          yield* through(node, id, nodes.executor(node).sessions.suspend(id));
          return yield* current(id);
        }),
        resume: Effect.fn("Sessions.resume")(function* (caller, id) {
          const { node } = yield* placed(caller, id);
          yield* store.desire(id, "running");
          yield* through(node, id, nodes.executor(node).sessions.resume(id));
          return yield* current(id);
        }),
        delete: Effect.fn("Sessions.delete")(function* (caller, id) {
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
        }),
        admit: Effect.fn("Sessions.admit")(function* (caller, id, options) {
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
                : `${node.publicUrl}/sessions/${id}/?token=${issued.ticket}`,
          };
        }),
        heard: (node, session) => inTurn(node, observe(node, session)),
        gone: (node, id) =>
          inTurn(
            node,
            Effect.flatMap(now, (at) => store.gone(node.id, id, at)),
          ),
        reconcile: Effect.fn("Sessions.reconcile")(function* (node) {
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
        }),
        unreachable: (node) => Effect.flatMap(now, (at) => store.unreachable(node.id, at)),
        unreachableExceptOn: (alive) =>
          Effect.flatMap(now, (at) =>
            store.unreachableExceptOn(
              alive.map((node) => node.id),
              at,
            ),
          ),
      });
    }),
  );
}
