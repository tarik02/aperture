import {
  type Access,
  type Caller,
  type ObservedState,
  ProxyConfig,
} from "@aperture-browser/control-api";
import { type ExecutorError, proto, type ProxyConfigInit } from "@aperture-browser/executor-client";
import * as UrlPath from "@aperture-browser/shared/url-path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { accountOf, reaches } from "../accounts/caller.ts";
import {
  type NodeRefused,
  type NodeUnreachable,
  NoNode,
  SessionHasNoNode,
  SessionNotFound,
  SnapshotNotFound,
  WorkspaceNotFound,
} from "../errors.ts";
import { asked } from "../nodes/asked.ts";
import type { Node } from "../nodes/schemas.ts";
import { Nodes } from "../nodes/service.ts";
import { SnapshotsStore } from "../snapshots/store.ts";
import { Tickets } from "../tickets/service.ts";
import { now } from "../time.ts";
import { Vault } from "../vault/service.ts";
import type { Admission, Observation } from "./schemas.ts";
import { type NewSessionOptions, Sessions } from "./service.ts";
import { type SessionDescription, SessionsStore } from "./store.ts";

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

/** A session's routing as its node's executor takes it. */
const toExecutor = (proxy: ProxyConfig): ProxyConfigInit => ({
  upstreams: Object.fromEntries(
    Object.entries(proxy.upstreams ?? {}).map(([name, upstream]) => [name, { ...upstream }]),
  ),
  rules: proxy.rules.map((rule) => ({ ...rule })),
});

const ProxyJson = Schema.fromJsonString(ProxyConfig);
const encodeProxy = Schema.encodeSync(ProxyJson);
const decodeProxy = Schema.decodeUnknownEffect(ProxyJson);

export const makeSessions = Effect.fn("Sessions.make")(function* () {
  const store = yield* SessionsStore;
  const snapshots = yield* SnapshotsStore;
  const nodes = yield* Nodes;
  const tickets = yield* Tickets;
  const vault = yield* Vault;

  const seal = (id: string, proxy: ProxyConfig | null) =>
    proxy === null ? Effect.succeed(null) : vault.seal(encodeProxy(proxy), id);

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
    const mine = Option.filter(session, (found) => reaches(caller, found));
    return yield* Option.match(mine, {
      onNone: () => Effect.fail(new SessionNotFound({ id })),
      onSome: Effect.succeed,
    });
  });

  const placed = Effect.fn("Sessions.placed")(function* (caller: Caller, id: string) {
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

  /** The nodes a session of the snapshot may go to, among those a session may go to at all. */
  const having = Effect.fn(function* (
    caller: Caller,
    snapshotId: string,
    candidates: ReadonlyArray<Node>,
  ) {
    const snapshot = Option.filter(yield* snapshots.find(snapshotId), (found) =>
      reaches(caller, found),
    );
    if (Option.isNone(snapshot)) {
      return yield* new SnapshotNotFound({ id: snapshotId });
    }
    const { shared, nodeId } = snapshot.value;
    return candidates.filter((node) =>
      shared ? node.offers?.sharesSnapshots === true : node.id === nodeId,
    );
  });

  const place = (
    candidates: ReadonlyArray<Node>,
    wanted: {
      readonly suspended: boolean;
      readonly snapshotId: string | undefined;
      readonly proxy: ProxyConfig | undefined;
    },
  ): Effect.Effect<readonly [Node, proto.Session], NoNode | NodeRefused> => {
    const [node, ...rest] = candidates;
    if (node === undefined) {
      return Effect.fail(new NoNode({ message: "no node is there to run a session" }));
    }
    return nodes
      .executor(node)
      .sessions.create({
        suspended: wanted.suspended,
        snapshotId: wanted.snapshotId,
        ...(wanted.proxy === undefined ? {} : { proxy: toExecutor(wanted.proxy) }),
      })
      .pipe(
        asked(node),
        Effect.map((session) => [node, session] as const),
        Effect.catchTag("NodeUnreachable", (error) =>
          Effect.logWarning(`node ${node.name} did not take a session: ${error.message}`).pipe(
            Effect.andThen(place(rest, wanted)),
          ),
        ),
      );
  };

  const create = Effect.fn("Sessions.create")(function* (
    caller: Caller,
    options: NewSessionOptions,
  ) {
    const account = yield* accountOf(caller);
    const workspaceId = options.workspaceId ?? null;
    if (workspaceId !== null && !caller.workspaces.some((one) => one.id === workspaceId)) {
      return yield* new WorkspaceNotFound({ id: workspaceId });
    }
    const alive = yield* nodes.candidates();
    const candidates =
      options.snapshotId === undefined ? alive : yield* having(caller, options.snapshotId, alive);
    const [node, session] = yield* place(candidates, {
      suspended: options.suspended,
      snapshotId: options.snapshotId,
      proxy: options.proxy,
    });
    const created = session.createdAt;
    yield* store.insert({
      id: session.id,
      accountId: account.id,
      workspaceId,
      nodeId: node.id,
      desiredState: options.suspended ? "suspended" : "running",
      observedState: observationOf(session)?.state ?? "starting",
      failure: session.failure ?? null,
      snapshotId: session.snapshotId ?? null,
      label: options.label ?? null,
      tags: options.tags,
      createdAt: created === undefined ? yield* now : new Date(Number(created.seconds) * 1000),
      now: yield* now,
    });
    yield* store.keepProxy(session.id, yield* seal(session.id, options.proxy ?? null));
    // What the node said of the session while there was no record of it was dropped.
    yield* Effect.ignore(refresh(node, session.id));
    return yield* Effect.orDie(current(session.id));
  });

  const list = Effect.fn("Sessions.list")(function* (caller: Caller) {
    if (caller.admin) {
      return yield* store.list();
    }
    return yield* Option.match(caller.account, {
      onSome: (account) =>
        store.listOf(
          account.id,
          caller.workspaces.map((workspace) => workspace.id),
        ),
      onNone: () => Effect.succeed([]),
    });
  });

  const get = Effect.fn("Sessions.get")(function* (caller: Caller, id: string) {
    return yield* owned(caller, id);
  });

  const describe = Effect.fn("Sessions.describe")(function* (
    caller: Caller,
    id: string,
    said: SessionDescription,
  ) {
    yield* owned(caller, id);
    yield* store.describe(id, said);
    return yield* current(id);
  });

  const proxy = Effect.fn("Sessions.proxy")(function* (caller: Caller, id: string) {
    yield* owned(caller, id);
    const sealed = yield* store.proxyOf(id);
    if (Option.isNone(sealed)) {
      return null;
    }
    // One that does not open, as after the master key changed, is told as none: the
    // session's node still routes by it, and setting it again makes it known here.
    return yield* vault.open(sealed.value, id).pipe(
      Effect.flatMap(decodeProxy),
      Effect.catch(() => Effect.succeed(null)),
    );
  });

  const setProxy = Effect.fn("Sessions.setProxy")(function* (
    caller: Caller,
    id: string,
    given: ProxyConfig | null,
  ) {
    const { node } = yield* placed(caller, id);
    yield* nodes
      .executor(node)
      .sessions.setProxy(id, given === null ? undefined : toExecutor(given))
      .pipe(asked(node));
    yield* store.keepProxy(id, yield* seal(id, given));
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
    describe,
    proxy,
    setProxy,
    placed,
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
