import {
  type Access,
  type Caller,
  covers,
  type ObservedState,
  ProxyConfig,
} from "@aperture-browser/control-api";
import {
  type ExecutorError,
  type LimitsInit,
  proto,
  type ProxyConfigInit,
} from "@aperture-browser/executor-client";
import * as UrlPath from "@aperture-browser/shared/url-path";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { accountOf, actsOn, notTheirs, reaches, type Reach } from "../accounts/caller.ts";
import {
  FileLinkInvalid,
  Forbidden,
  QuotaExceeded,
  type NodeRefused,
  type NodeUnreachable,
  NoNode,
  SessionHasNoNode,
  SessionNotFound,
  SnapshotNotFound,
  WorkspaceNotFound,
} from "../errors.ts";
import { SYSTEM } from "../events/schemas.ts";
import { Events } from "../events/service.ts";
import * as Metrics from "../metrics.ts";
import { asked } from "../nodes/asked.ts";
import type { Node } from "../nodes/schemas.ts";
import { Nodes } from "../nodes/service.ts";
import { limitsOf } from "../policy/limits.ts";
import { type Effective, Policy } from "../policy/service.ts";
import { SnapshotsStore } from "../snapshots/store.ts";
import { Tickets } from "../tickets/service.ts";
import { now } from "../time.ts";
import { Vault } from "../vault/service.ts";
import { sessionPath } from "../routing/paths.ts";
import type { Admission, FileLink, Observation, Session } from "./schemas.ts";
import { type ExpiryReasons, type NewSessionOptions, Sessions } from "./service.ts";
import { type ExpiryDue, type SessionDescription, SessionsStore } from "./store.ts";

const STATES: Record<proto.SessionState, ObservedState | undefined> = {
  [proto.SessionState.UNSPECIFIED]: undefined,
  [proto.SessionState.SUSPENDED]: "suspended",
  [proto.SessionState.STARTING]: "starting",
  [proto.SessionState.RESTORING]: "restoring",
  [proto.SessionState.RUNNING]: "running",
  [proto.SessionState.SUSPENDING]: "suspending",
  [proto.SessionState.FAILED]: "failed",
};

/** What a node says of a session; nothing where it says a state this program does not know. */
const observationOf = (session: proto.Session): Observation | undefined => {
  const state = STATES[session.state];
  return state === undefined
    ? undefined
    : { id: session.id, state, failure: session.failure ?? null, asleep: session.asleep };
};

/** A session's routing as its node's executor takes it. */
const toExecutor = (proxy: ProxyConfig): ProxyConfigInit => ({
  upstreams: Object.fromEntries(
    Object.entries(proxy.upstreams ?? {}).map(([name, upstream]) => [name, { ...upstream }]),
  ),
  rules: proxy.rules.map((rule) => ({ ...rule })),
});

const UPLOADS = "uploads";
/** The directories of a session's files, each with the area of access its files are read by. */
const FILE_AREAS: Readonly<Record<string, keyof Access | undefined>> = {
  [UPLOADS]: "uploads",
  downloads: "downloads",
  recordings: "recordings",
  screenshots: "recordings",
};
const FILE_LINK_LASTS = Duration.minutes(5);
/**
 * How long a session that is to run may be at rest on its node before it is started again,
 * and between the first two tries: a session is at rest for a moment while it is suspended
 * and started again, as for a snapshot. Each try waits twice as long as the one before.
 */
const RESTART_AFTER = Duration.seconds(10);
/** How often it is tried before the session is told as failed. */
const RESTART_TRIES = 3;

const ProxyJson = Schema.fromJsonString(ProxyConfig);
const encodeProxy = Schema.encodeSync(ProxyJson);
const decodeProxy = Schema.decodeUnknownEffect(ProxyJson);

export const makeSessions = Effect.fn("Sessions.make")(function* () {
  const store = yield* SessionsStore;
  const snapshots = yield* SnapshotsStore;
  const nodes = yield* Nodes;
  const tickets = yield* Tickets;
  const vault = yield* Vault;
  const events = yield* Events;
  const policy = yield* Policy;

  /** A session as an event is about it. */
  const about = (session: Session) =>
    ({
      resource: { kind: "session", id: session.id, label: session.label },
      ownerId: session.accountId,
      workspaceId: session.workspaceId,
    }) as const;

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

  // The sessions that are to run and that their nodes have at rest, which are started
  // again here: how often that was tried, and when it is next. Kept here alone: a control
  // plane that starts again tries anew.
  const restarts = new Map<
    string,
    { readonly tries: number; readonly next: number; readonly refused: string | null }
  >();
  // Those that were tried as often as they are, with why the last try did not start them.
  // Told as failed for as long as their node has them at rest and nobody asks for more.
  const givenUp = new Map<string, string>();
  const forget = (id: string) => {
    restarts.delete(id);
    givenUp.delete(id);
  };

  const observe = Effect.fn(function* (node: Node, session: proto.Session) {
    const seen = observationOf(session);
    if (seen === undefined) {
      return;
    }
    const reason = givenUp.get(seen.id);
    const told =
      reason !== undefined && seen.state === "suspended"
        ? { ...seen, state: "failed" as const, failure: reason }
        : seen;
    yield* store.observe(node.id, told, yield* now);
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
    const mine = Option.filter(session, (found) =>
      reaches(caller, found, { kind: "sessions", id: found.id }),
    );
    return yield* Option.match(mine, {
      onNone: () => Effect.fail(new SessionNotFound({ id })),
      onSome: Effect.succeed,
    });
  });

  /** The caller's session to act on: one they only see is refused, and said why. */
  const acted = Effect.fn("Sessions.acted")(function* (caller: Caller, id: string) {
    const session = yield* owned(caller, id);
    if (!actsOn(caller, session, { kind: "sessions", id })) {
      return yield* notTheirs();
    }
    return session;
  });

  const placed = Effect.fn("Sessions.placed")(function* (caller: Caller, id: string, reach: Reach) {
    const session = yield* (reach === "act" ? acted : owned)(caller, id);
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
      reaches(caller, found, { kind: "snapshots", id: found.id }),
    );
    if (Option.isNone(snapshot)) {
      return yield* new SnapshotNotFound({ id: snapshotId });
    }
    // A session of a snapshot has what the snapshot has: its logins are used, not seen.
    if (!actsOn(caller, snapshot.value, { kind: "snapshots", id: snapshotId })) {
      return yield* notTheirs();
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
      readonly storageState: string | undefined;
      readonly limits: (node: Node) => LimitsInit;
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
        limits: wanted.limits(node),
        ...(wanted.proxy === undefined ? {} : { proxy: toExecutor(wanted.proxy) }),
        ...(wanted.storageState === undefined ? {} : { storageState: wanted.storageState }),
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

  /** Refuses one more session where its settings say there are as many as there may be. */
  const withinQuotas = Effect.fn("Sessions.withinQuotas")(function* (
    effective: Effective,
    workspaceId: string | null,
    accountId: string | null,
    asked: { readonly creating: boolean; readonly running: boolean },
  ) {
    const quotas: ReadonlyArray<{
      readonly setting: Effective[keyof Effective];
      readonly what: string;
      readonly counted: () => Effect.Effect<number>;
    }> = [
      ...(asked.creating && accountId !== null
        ? [
            {
              setting: effective.sessionsPerUser,
              what: "sessions of one user",
              counted: () => store.count({ workspaceId, accountId, running: false }),
            },
            ...(workspaceId === null
              ? []
              : [
                  {
                    setting: effective.sessionsPerWorkspace,
                    what: "sessions of the workspace",
                    counted: () => store.count({ workspaceId, accountId: null, running: false }),
                  },
                ]),
          ]
        : []),
      // A session of no workspace and nobody's is counted against nothing.
      ...(asked.running && (workspaceId !== null || accountId !== null)
        ? [
            {
              setting: effective.runningSessions,
              what: "running sessions",
              counted: () =>
                store.count({
                  workspaceId,
                  accountId: workspaceId === null ? accountId : null,
                  running: true,
                }),
            },
          ]
        : []),
    ];
    for (const { setting, what, counted } of quotas) {
      if (typeof setting.value !== "number") {
        continue;
      }
      if ((yield* counted()) >= setting.value) {
        const level = setting.source === "node" ? "default" : setting.source;
        return yield* new QuotaExceeded({
          what,
          level,
          limit: setting.value,
          message: `${setting.value} ${what} are the most there may be: the ${level} says so`,
        });
      }
    }
  });

  const create = Effect.fn("Sessions.create")(function* (
    caller: Caller,
    options: NewSessionOptions,
  ) {
    const account = yield* accountOf(caller);
    const workspaceId = options.workspaceId ?? null;
    // A token held to resources makes sessions only where it reaches what is made.
    if (
      caller.resources !== null &&
      (workspaceId === null || !caller.resources.workspaces.includes(workspaceId))
    ) {
      return yield* new Forbidden({
        message: "this token makes sessions only in the workspaces it is held to",
      });
    }
    if (workspaceId !== null && !caller.workspaces.some((one) => one.id === workspaceId)) {
      return yield* caller.admin ? notTheirs() : new WorkspaceNotFound({ id: workspaceId });
    }
    // A session of a snapshot has what the snapshot has: making one reads it.
    if (options.snapshotId !== undefined && !covers(caller.scopes, "snapshots:read")) {
      return yield* new Forbidden({ message: "this token is not for snapshots:read" });
    }
    const alive = yield* nodes.candidates();
    const candidates =
      options.snapshotId === undefined ? alive : yield* having(caller, options.snapshotId, alive);
    const effective = yield* policy.of({
      workspaceId,
      accountId: account.id,
      sessionId: null,
      pinned: false,
    });
    const asked = { creating: true, running: !options.suspended } as const;
    // Refused at once, before its node is asked; and again as its record is written, alone
    // among the others of its workspace, so that no two at once get past a quota.
    yield* withinQuotas(effective, workspaceId, account.id, asked);
    const [node, session] = yield* place(candidates, {
      limits: (node) => limitsOf(effective, node.offers?.holdsResources === true),
      suspended: options.suspended,
      snapshotId: options.snapshotId,
      proxy: options.proxy,
      storageState:
        options.storageState === undefined ? undefined : JSON.stringify(options.storageState),
    });
    const created = session.createdAt;
    const at = yield* now;
    const recorded = store.insert({
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
      createdAt: created === undefined ? at : new Date(Number(created.seconds) * 1000),
      now: at,
    });
    yield* store
      .alone(
        { workspaceId, accountId: account.id },
        Effect.andThen(withinQuotas(effective, workspaceId, account.id, asked), recorded),
      )
      .pipe(Effect.tapError(() => Effect.ignore(removedOn(node, session.id))));
    yield* store.keepProxy(session.id, yield* seal(session.id, options.proxy ?? null));
    // What the node said of the session while there was no record of it was dropped.
    yield* Effect.ignore(refresh(node, session.id));
    const made = yield* Effect.orDie(current(session.id));
    yield* events.record({
      kind: "session.created",
      ...about(made),
      detail: { node: node.name, snapshotId: made.snapshotId, suspended: options.suspended },
    });
    return made;
  }, Metrics.sessionRequest("create"));

  const list = Effect.fn("Sessions.list")(function* (caller: Caller) {
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
    return all.filter((session) => reaches(caller, session, { kind: "sessions", id: session.id }));
  });

  const get = Effect.fn("Sessions.get")(function* (caller: Caller, id: string) {
    return yield* owned(caller, id);
  });

  const describe = Effect.fn("Sessions.describe")(function* (
    caller: Caller,
    id: string,
    said: SessionDescription,
  ) {
    yield* acted(caller, id);
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
    const { node } = yield* placed(caller, id, "act");
    yield* nodes
      .executor(node)
      .sessions.setProxy(id, given === null ? undefined : toExecutor(given))
      .pipe(asked(node));
    yield* store.keepProxy(id, yield* seal(id, given));
  });

  const suspend = Effect.fn("Sessions.suspend")(function* (caller: Caller, id: string) {
    const { session, node } = yield* placed(caller, id, "act");
    forget(id);
    yield* store.desire(id, "suspended");
    yield* through(node, id, nodes.executor(node).sessions.suspend(id));
    yield* events.record({ kind: "session.suspended", ...about(session) });
    return yield* current(id);
  }, Metrics.sessionRequest("suspend"));

  const resume = Effect.fn("Sessions.resume")(function* (caller: Caller, id: string) {
    const { session, node } = yield* placed(caller, id, "act");
    forget(id);
    const effective = yield* policy.of({
      workspaceId: session.workspaceId,
      accountId: session.accountId,
      sessionId: session.id,
      pinned: session.pinned,
    });
    yield* store.alone(
      session,
      Effect.gen(function* () {
        const fresh = yield* current(id);
        // One that runs, and is not asleep, is counted already.
        if (fresh.desiredState !== "running" || fresh.asleep) {
          yield* withinQuotas(effective, fresh.workspaceId, fresh.accountId, {
            creating: false,
            running: true,
          });
        }
        yield* store.desire(id, "running");
      }),
    );
    yield* through(node, id, nodes.executor(node).sessions.resume(id));
    yield* events.record({ kind: "session.resumed", ...about(session) });
    return yield* current(id);
  }, Metrics.sessionRequest("resume"));

  /** Deletes a session on its node. */
  const removedOn = (node: Node, id: string) =>
    nodes
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

  const delete_ = Effect.fn("Sessions.delete")(function* (caller: Caller, id: string) {
    const { session, node } = yield* placed(caller, id, "act");
    yield* removedOn(node, id);
    yield* store.delete(id, yield* now);
    forget(id);
    yield* events.record({ kind: "session.deleted", ...about(session) });
  }, Metrics.sessionRequest("delete"));

  const expire = Effect.fn("Sessions.expire")(function* (
    id: string,
    due: ExpiryDue,
    reasons: ExpiryReasons,
  ) {
    const at = yield* now;
    // Whether it is still due is decided as it is deleted, so that one pinned or resumed
    // since it was looked at stays; its node is asked after.
    const expired = yield* store.expire(id, due, at);
    if (Option.isNone(expired)) {
      return false;
    }
    const session = expired.value;
    const node = session.nodeId === null ? Option.none<Node>() : yield* nodes.find(session.nodeId);
    // One that is on no node is had by nothing but its record.
    if (Option.isSome(node)) {
      yield* removedOn(node.value, id).pipe(
        // What its node did not delete is tried again the next time.
        Effect.tapError(() => store.restore(id, at)),
      );
    }
    const aged =
      due.createdBefore !== null &&
      DateTime.toEpochMillis(session.createdAt) <= due.createdBefore.getTime();
    yield* events.record({
      kind: "session.deleted",
      ...about(session),
      actor: SYSTEM,
      address: null,
      detail: { reason: aged ? reasons.aged : reasons.suspended },
    });
    return true;
  });

  const pin = Effect.fn("Sessions.pin")(function* (caller: Caller, id: string, pinned: boolean) {
    const session = yield* acted(caller, id);
    if (session.pinned === pinned) {
      return session;
    }
    const effective = yield* policy.of({
      workspaceId: session.workspaceId,
      accountId: session.accountId,
      sessionId: session.id,
      pinned: session.pinned,
    });
    const who = effective.pinning.value;
    const administers =
      session.workspaceId === null
        ? Option.exists(caller.account, (account) => account.id === session.accountId)
        : caller.workspaces.some((one) => one.id === session.workspaceId && one.role === "admin");
    // Whoever acts on a session unpins it, whoever its settings say pins it.
    if (pinned && (who === "nobody" || (who === "admins" && !administers))) {
      return yield* new Forbidden({
        message:
          who === "nobody"
            ? `nobody pins a session here: the ${effective.pinning.source} says so`
            : `only an admin of the workspace pins its sessions: the ${effective.pinning.source} says so`,
      });
    }
    const most = effective.maxPinnedSessions;
    yield* store.alone(
      session,
      Effect.gen(function* () {
        if (pinned && typeof most.value === "number") {
          const already = yield* store.pinnedOf(session.workspaceId, session.accountId);
          if (already >= most.value) {
            return yield* new QuotaExceeded({
              what: "pinned sessions",
              level: most.source === "node" ? "default" : most.source,
              limit: most.value,
              message: `${most.value} pinned sessions are the most there are here: the ${most.source} says so`,
            });
          }
        }
        yield* store.pin(id, pinned);
      }),
    );
    yield* events.record({
      kind: pinned ? "session.pinned" : "session.unpinned",
      ...about(session),
    });
    yield* policy.touched();
    return yield* current(id);
  });

  /** Where a session is reached from outside: on its node, or through the proxy before it. */
  const reachedAt = (node: Node, id: string, origin: string) =>
    node.publicUrl === null
      ? `${origin}${sessionPath(node.id, id)}`
      : UrlPath.make`${UrlPath.raw(node.publicUrl)}/sessions/${id}`;

  const admit = Effect.fn("Sessions.admit")(function* (
    caller: Caller,
    id: string,
    options: { readonly name: string | undefined; readonly access: Access },
    origin: string,
  ) {
    const account = yield* accountOf(caller);
    // A ticket that gives no access watches, which is seeing the session.
    const watches = Object.values(options.access).every((given) => given === undefined);
    const { node } = yield* placed(caller, id, watches ? "read" : "act");
    const issued = yield* tickets.issue({
      sessionId: id,
      subject: account.id,
      name: options.name ?? account.name,
      access: options.access,
    });
    return {
      ...issued,
      url: UrlPath.make`${UrlPath.raw(reachedAt(node, id, origin))}/?token=${issued.ticket}`,
    } satisfies Admission;
  });

  const fileLink = Effect.fn("Sessions.fileLink")(function* (
    caller: Caller,
    id: string,
    asked: {
      readonly path: string;
      readonly write: boolean;
      readonly lasts: Duration.Duration | undefined;
    },
    origin: string,
  ) {
    const account = yield* accountOf(caller);
    // A file the session has is read by whoever sees it; one is put into it by whoever acts.
    const { node } = yield* placed(caller, id, asked.write ? "act" : "read");
    const [directory = "", ...below] = asked.path.split("/");
    const area = FILE_AREAS[directory];
    if (area === undefined || below.length === 0) {
      return yield* new FileLinkInvalid({ message: `${asked.path} is no file of a session` });
    }
    // What is put into a session is an upload, under a name and in no directory of its own.
    if (asked.write && (directory !== UPLOADS || below.length !== 1)) {
      return yield* new FileLinkInvalid({
        message: `a file is put at ${UPLOADS}/<name>, and nowhere else`,
      });
    }
    const named = below.map(encodeURIComponent).join("/");
    const route = asked.write ? `/${UPLOADS}/${named}` : `/files/${directory}/${named}`;
    const issued = yield* tickets.issue({
      sessionId: id,
      subject: account.id,
      name: account.name,
      access: { [area]: asked.write ? "w" : "r" },
      path: route,
      lasts: asked.lasts ?? FILE_LINK_LASTS,
    });
    return {
      url: `${reachedAt(node, id, origin)}${route}?token=${issued.ticket}`,
      method: asked.write ? "PUT" : "GET",
      expiresAt: issued.expiresAt,
    } satisfies FileLink;
  });

  const heard = Effect.fn("Sessions.heard")(function* (node: Node, session: proto.Session) {
    yield* inTurn(node, observe(node, session));
  });

  const gone = Effect.fn("Sessions.gone")(function* (node: Node, id: string) {
    forget(id);
    yield* inTurn(
      node,
      Effect.flatMap(now, (at) => store.gone(node.id, id, at)),
    );
  });

  /**
   * Starts the session again where it is to run and its node has it at rest, as after its
   * node lost what it ran: a while after it was first seen so, and again for as long as it
   * stays so, up to as often as it is tried. One that sat idle is not: whoever reaches it
   * resumes it.
   */
  const restart = Effect.fn("Sessions.restart")(function* (node: Node, session: proto.Session) {
    const { id } = session;
    switch (session.state) {
      case proto.SessionState.SUSPENDED:
        break;
      case proto.SessionState.STARTING:
      case proto.SessionState.SUSPENDING:
        return;
      default:
        forget(id);
        return;
    }
    const record = yield* store.find(id);
    if (
      session.asleep ||
      Option.isNone(record) ||
      record.value.desiredState !== "running" ||
      record.value.nodeId !== node.id
    ) {
      forget(id);
      return;
    }
    if (givenUp.has(id)) {
      return;
    }
    const at = (yield* now).getTime();
    const planned = restarts.get(id);
    if (planned === undefined) {
      restarts.set(id, { tries: 0, next: at + Duration.toMillis(RESTART_AFTER), refused: null });
      return;
    }
    if (at < planned.next) {
      return;
    }
    if (planned.tries >= RESTART_TRIES) {
      const reason =
        planned.refused === null
          ? `it was started again ${planned.tries} times, and is at rest still`
          : `it was not started again: ${planned.refused}`;
      restarts.delete(id);
      givenUp.set(id, reason);
      yield* Effect.logError(
        `session ${id} on node ${node.name} is to run and does not: ${reason}`,
      );
      yield* Effect.ignore(refresh(node, id));
      return;
    }
    const tries = planned.tries + 1;
    yield* Effect.logWarning(
      `session ${id} is to run and node ${node.name} has it at rest; starting it again (${tries} of ${RESTART_TRIES})`,
    );
    const refused = yield* nodes
      .executor(node)
      .sessions.resume(id)
      .pipe(
        asked(node),
        Effect.as(null),
        Effect.catch((error) => Effect.succeed(error.message)),
      );
    restarts.set(id, {
      tries,
      next: (yield* now).getTime() + Duration.toMillis(RESTART_AFTER) * 2 ** tries,
      refused,
    });
    yield* Effect.ignore(refresh(node, id));
  });

  const reconcile = Effect.fn("Sessions.reconcile")(function* (node: Node) {
    const there = yield* nodes.executor(node).sessions.list;
    yield* Effect.forEach(there, (session) => inTurn(node, observe(node, session)), {
      discard: true,
    });
    yield* Effect.forEach(there, (session) => restart(node, session), {
      concurrency: "unbounded",
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
    acted,
    suspend,
    resume,
    delete: delete_,
    expire,
    pin,
    admit,
    fileLink,
    heard,
    gone,
    reconcile,
    unreachable,
    unreachableExceptOn,
  });
});

export const layer = Layer.effect(Sessions, makeSessions());
