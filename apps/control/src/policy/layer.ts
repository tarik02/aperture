import {
  type Caller,
  type EventResource,
  type SettingEntry,
  type SettingKey,
  type SettingView,
  SETTINGS,
  saidAt,
} from "@aperture-browser/control-api";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { accountOf, actsOn, reaches } from "../accounts/caller.ts";
import { Forbidden, SessionNotFound, WorkspaceNotFound } from "../errors.ts";
import { Events } from "../events/service.ts";
import { SessionsStore } from "../sessions/store.ts";
import { Settings } from "../settings/service.ts";
import { now } from "../time.ts";
import { WorkspacesStore } from "../workspaces/store.ts";
import { type Base, boundsOf, type Chain, check, resolve } from "./cascade.ts";
import { type Effective, type Place, Policy, type Target } from "./service.ts";
import { PolicyStore, type Said, type Scope } from "./store.ts";

const KEYS = Object.keys(SETTINGS) as ReadonlyArray<SettingKey>;

/** What the levels say, by level, scope and setting. */
type Index = ReadonlyMap<string, SettingEntry>;

const at = (scope: Scope, key: SettingKey) => `${scope.level}\u0000${scope.scopeId}\u0000${key}`;

const indexOf = (said: ReadonlyArray<Said>): Index =>
  new Map(said.map((one) => [at(one, one.key), one.entry]));

/** The levels on the way to a session, the widest first. */
const scopesOf = (place: Place): ReadonlyArray<Scope> => [
  { level: "instance", scopeId: "" },
  ...(place.workspaceId === null
    ? []
    : [{ level: "workspace", scopeId: place.workspaceId } as const]),
  ...(place.accountId === null ? [] : [{ level: "account", scopeId: place.accountId } as const]),
  ...(place.sessionId === null ? [] : [{ level: "session", scopeId: place.sessionId } as const]),
];

/** What the levels on the way say of one setting, of those it is said at. */
const chainOf = (index: Index, scopes: ReadonlyArray<Scope>, key: SettingKey): Chain =>
  scopes
    .filter((scope) => saidAt(key, scope.level))
    .map((scope) => ({ level: scope.level, entry: index.get(at(scope, key)) }));

/** Whether an entry says anything at all. */
const saysSomething = (entry: SettingEntry) =>
  entry.value !== undefined ||
  entry.min !== undefined ||
  entry.max !== undefined ||
  entry.allowed !== undefined;

export const makePolicy = Effect.fn("Policy.make")(function* () {
  const store = yield* PolicyStore;
  const sessions = yield* SessionsStore;
  const workspaces = yield* WorkspacesStore;
  const events = yield* Events;
  const { settingDefaults } = yield* Settings;
  const changed = yield* PubSub.unbounded<void>();

  const base = (key: SettingKey): Base => {
    const configured = settingDefaults[key];
    return configured === undefined
      ? { value: SETTINGS[key].fallback, source: "default" }
      : { value: configured, source: "configuration" };
  };

  const effectiveOf = (index: Index, scopes: ReadonlyArray<Scope>) =>
    Object.fromEntries(
      KEYS.map((key) => [key, resolve(key, chainOf(index, scopes, key), base(key))]),
    ) as Effective;

  /**
   * The level a caller asks after, if they see it: the scopes on the way to it, the
   * widest first and it last, whether they change what it says, and what it is about.
   */
  const reached = Effect.fn("Policy.reached")(function* (caller: Caller, target: Target) {
    switch (target.level) {
      case "instance":
        return {
          scopes: scopesOf({ workspaceId: null, accountId: null, sessionId: null }),
          writes: caller.admin,
          resource: null,
          workspaceId: null,
        };
      case "workspace": {
        const workspace = yield* workspaces.find(target.id);
        const role = caller.workspaces.find((one) => one.id === target.id)?.role ?? null;
        const held = caller.resources !== null && !caller.resources.workspaces.includes(target.id);
        if (Option.isNone(workspace) || (role === null && !caller.admin) || held) {
          return yield* new WorkspaceNotFound({ id: target.id });
        }
        return {
          scopes: scopesOf({ workspaceId: target.id, accountId: null, sessionId: null }),
          // What a workspace's admins say of it, as they say who is in it.
          writes: role === "admin" || caller.admin,
          resource: { kind: "workspace", id: target.id, label: workspace.value.name } as const,
          workspaceId: target.id,
        };
      }
      case "account": {
        const account = yield* accountOf(caller);
        const { workspaceId } = target;
        if (workspaceId !== null && !caller.workspaces.some((one) => one.id === workspaceId)) {
          return yield* new WorkspaceNotFound({ id: workspaceId });
        }
        return {
          scopes: scopesOf({ workspaceId, accountId: account.id, sessionId: null }),
          writes: true,
          resource: { kind: "account", id: account.id, label: account.name } as const,
          workspaceId,
        };
      }
      case "session": {
        const found = Option.filter(yield* sessions.find(target.id), (session) =>
          reaches(caller, session, { kind: "sessions", id: session.id }),
        );
        if (Option.isNone(found)) {
          return yield* new SessionNotFound({ id: target.id });
        }
        const session = found.value;
        const mine = Option.exists(caller.account, (account) => account.id === session.accountId);
        const administers =
          session.workspaceId === null ||
          caller.workspaces.some((one) => one.id === session.workspaceId && one.role === "admin");
        return {
          scopes: scopesOf({
            workspaceId: session.workspaceId,
            accountId: session.accountId,
            sessionId: session.id,
          }),
          // What a session's maker says of it, or an admin of its workspace.
          writes:
            actsOn(caller, session, { kind: "sessions", id: session.id }) && (mine || administers),
          resource: { kind: "session", id: session.id, label: session.label } as const,
          workspaceId: session.workspaceId,
        };
      }
    }
  });

  const viewOf = (
    index: Index,
    scopes: ReadonlyArray<Scope>,
    writes: boolean,
    key: SettingKey,
  ): SettingView => {
    const here = scopes[scopes.length - 1] ?? { level: "instance", scopeId: "" };
    const chain = chainOf(index, scopes, key);
    const saidHere = saidAt(key, here.level);
    return {
      key,
      here: saidHere ? (index.get(at(here, key)) ?? null) : null,
      effective: resolve(key, chain, base(key)),
      above: boundsOf(chain.filter((link) => link.level !== here.level)),
      changeable: writes && saidHere,
    };
  };

  const views = Effect.fn("Policy.views")(function* (caller: Caller, target: Target) {
    const { scopes, writes } = yield* reached(caller, target);
    const index = indexOf(yield* store.of(scopes));
    return KEYS.map((key) => viewOf(index, scopes, writes, key));
  });

  const recorded = (
    kind: "setting.changed" | "setting.cleared",
    target: Target,
    reach: {
      readonly resource: EventResource | null;
      readonly workspaceId: string | null;
    },
    key: SettingKey,
    entry: SettingEntry,
  ) =>
    events.record({
      kind,
      resource: reach.resource,
      ownerId: reach.resource?.kind === "account" ? reach.resource.id : null,
      workspaceId: reach.workspaceId,
      detail: {
        key,
        level: target.level,
        ...(entry.value === undefined ? {} : { value: entry.value }),
        ...(entry.min === undefined ? {} : { min: entry.min }),
        ...(entry.max === undefined ? {} : { max: entry.max }),
        ...(entry.allowed === undefined ? {} : { allowed: entry.allowed.map(String) }),
      },
    });

  const refusedHere = (target: Target) =>
    new Forbidden({
      message:
        target.level === "instance"
          ? "the settings of the deployment are an admin's to say"
          : target.level === "workspace"
            ? "the settings of a workspace are for an admin of it to say"
            : "the settings of a session are for whoever made it, or an admin of its workspace, to say",
    });

  const set = Effect.fn("Policy.set")(function* (
    caller: Caller,
    target: Target,
    key: SettingKey,
    entry: SettingEntry,
  ) {
    const reach = yield* reached(caller, target);
    if (!reach.writes) {
      return yield* refusedHere(target);
    }
    const here = reach.scopes[reach.scopes.length - 1] ?? { level: "instance", scopeId: "" };
    const before = indexOf(yield* store.of(reach.scopes));
    const above = boundsOf(
      chainOf(before, reach.scopes, key).filter((link) => link.level !== here.level),
    );
    const checked = check(key, here.level, entry, above);
    if (Result.isFailure(checked)) {
      return yield* checked.failure;
    }
    if (saysSomething(entry)) {
      yield* store.put({ ...here, key, entry }, yield* now);
    } else {
      yield* store.remove(here, key);
    }
    yield* recorded("setting.changed", target, reach, key, entry);
    yield* touched();
    const index = indexOf(yield* store.of(reach.scopes));
    return viewOf(index, reach.scopes, reach.writes, key);
  });

  const clear = Effect.fn("Policy.clear")(function* (
    caller: Caller,
    target: Target,
    key: SettingKey,
  ) {
    const reach = yield* reached(caller, target);
    if (!reach.writes) {
      return yield* refusedHere(target);
    }
    const here = reach.scopes[reach.scopes.length - 1] ?? { level: "instance", scopeId: "" };
    yield* store.remove(here, key);
    yield* recorded("setting.cleared", target, reach, key, {});
    yield* touched();
    const index = indexOf(yield* store.of(reach.scopes));
    return viewOf(index, reach.scopes, reach.writes, key);
  });

  const of = Effect.fn("Policy.of")(function* (place: Place) {
    const scopes = scopesOf(place);
    return effectiveOf(indexOf(yield* store.of(scopes)), scopes);
  });

  const snapshot = Effect.fn("Policy.snapshot")(function* () {
    const index = indexOf(yield* store.all());
    return (place: Place) => effectiveOf(index, scopesOf(place));
  });

  const touched = Effect.fn("Policy.touched")(function* () {
    yield* PubSub.publish(changed, undefined);
  });

  return Policy.of({
    views,
    set,
    clear,
    of,
    snapshot,
    changes: Stream.fromPubSub(changed),
    touched,
  });
});

export const layer = Layer.effect(Policy, makePolicy());
