import {
  type Caller,
  type EventResource,
  type SettingEffective,
  type SettingEntry,
  type SettingKey,
  type SettingLevel,
  type SettingView,
  isQuota,
  PERSONAL,
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
import { AccountsStore } from "../accounts/store.ts";
import {
  AccountNotFound,
  Forbidden,
  SessionNotFound,
  SettingOutOfBounds,
  WorkspaceNotFound,
} from "../errors.ts";
import { Events } from "../events/service.ts";
import { SessionsStore } from "../sessions/store.ts";
import { Settings } from "../settings/service.ts";
import { now } from "../time.ts";
import { WorkspacesStore } from "../workspaces/store.ts";
import {
  awake,
  type Base,
  boundsOf,
  type Chain,
  check,
  heldBelow,
  noneOverNode,
  resolve,
} from "./cascade.ts";
import { type Effective, type Place, Policy, type Target } from "./service.ts";
import { PolicyStore, type Said, type Scope } from "./store.ts";

const KEYS = Object.keys(SETTINGS) as ReadonlyArray<SettingKey>;

/** What the levels say, by level, scope and setting. */
type Index = ReadonlyMap<string, SettingEntry>;

/**
 * The level a caller asks after: the scopes on the way to it, the widest first and it
 * last, and whether they say its values, and its bounds and quotas; whether they are an
 * admin of the deployment, whose bounds nobody else changes; and the levels of the person
 * it is of that they do not read.
 */
interface Reach {
  readonly scopes: ReadonlyArray<Scope>;
  readonly pinned: boolean;
  readonly values: boolean;
  readonly bounds: boolean;
  readonly admin: boolean;
  readonly hidden: ReadonlySet<SettingLevel>;
}

const NONE_HIDDEN: ReadonlySet<SettingLevel> = new Set();

const at = (scope: Scope, key: SettingKey) => `${scope.level}\u0000${scope.scopeId}\u0000${key}`;

const indexOf = (said: ReadonlyArray<Said>): Index =>
  new Map(said.map((one) => [at(one, one.key), one.entry]));

/** Where what is said has bounds an admin of the deployment said. */
const byAdminOf = (said: ReadonlyArray<Said>): ReadonlySet<string> =>
  new Set(said.filter((one) => one.byAdmin).map((one) => at(one, one.key)));

/** What a person has as a member of a workspace is said under both. */
export const memberScope = (workspaceId: string, accountId: string) =>
  `${workspaceId}:${accountId}`;

/** The levels on the way to a session, the widest first. */
const scopesOf = (place: Omit<Place, "pinned">): ReadonlyArray<Scope> => [
  { level: "instance", scopeId: "" },
  ...(place.workspaceId === null
    ? []
    : [{ level: "workspace", scopeId: place.workspaceId } as const]),
  ...(place.accountId === null ? [] : [{ level: "account", scopeId: place.accountId } as const]),
  ...(place.workspaceId === null || place.accountId === null
    ? []
    : [{ level: "member", scopeId: memberScope(place.workspaceId, place.accountId) } as const]),
  ...(place.sessionId === null ? [] : [{ level: "session", scopeId: place.sessionId } as const]),
];

/** What the levels on the way say of one setting, of those it is said at. */
const chainOf = (index: Index, scopes: ReadonlyArray<Scope>, key: SettingKey): Chain =>
  scopes
    .filter((scope) => saidAt(key, scope.level))
    .map((scope) => ({ level: scope.level, entry: index.get(at(scope, key)) }));

/** The bounds of an entry, without its value. */
const boundsPart = (entry: SettingEntry | undefined): SettingEntry => ({
  ...(entry?.min === undefined ? {} : { min: entry.min }),
  ...(entry?.max === undefined ? {} : { max: entry.max }),
  ...(entry?.allowed === undefined ? {} : { allowed: entry.allowed }),
});

/** Whether an entry says bounds other than those there are. */
const boundsChange = (entry: SettingEntry, there: SettingEntry | undefined) =>
  (entry.min !== undefined && entry.min !== there?.min) ||
  (entry.max !== undefined && entry.max !== there?.max) ||
  (entry.allowed !== undefined &&
    (there?.allowed === undefined ||
      entry.allowed.length !== there.allowed.length ||
      entry.allowed.some((one) => !there.allowed?.includes(one))));

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
  const accounts = yield* AccountsStore;
  const events = yield* Events;
  const { settingDefaults } = yield* Settings;
  const changed = yield* PubSub.unbounded<void>();

  const base = (key: SettingKey): Base => {
    const configured = settingDefaults[key];
    return configured === undefined
      ? { value: SETTINGS[key].fallback, source: "default" }
      : { value: configured, source: "configuration" };
  };

  /** What one setting comes to at the end of the scopes, for a session pinned or not. */
  const effectiveOne = (
    index: Index,
    scopes: ReadonlyArray<Scope>,
    pinned: boolean,
    key: SettingKey,
  ): SettingEffective => {
    const chain = chainOf(index, scopes, key);
    if (key === "suspendIdleAfter" && pinned) {
      const stays = effectiveOne(index, scopes, pinned, "pinnedStayAwake");
      if (stays.value === true) {
        return awake(chain, stays);
      }
    }
    return resolve(key, chain, base(key));
  };

  const effectiveOf = (index: Index, scopes: ReadonlyArray<Scope>, pinned: boolean) =>
    Object.fromEntries(
      KEYS.map((key) => [key, effectiveOne(index, scopes, pinned, key)]),
    ) as Effective;

  /** The level a caller asks after, if they see it, and what it is about. */
  const reached = Effect.fn("Policy.reached")(function* (caller: Caller, target: Target) {
    switch (target.level) {
      case "instance":
        return {
          scopes: scopesOf({ workspaceId: null, accountId: null, sessionId: null }),
          pinned: false,
          values: caller.admin,
          bounds: caller.admin,
          admin: caller.admin,
          hidden: NONE_HIDDEN,
          resource: null,
          ownerId: null,
          workspaceId: null,
          adminsOnly: false,
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
          pinned: false,
          // What a workspace's admins say of it, as they say who is in it.
          values: role === "admin" || caller.admin,
          bounds: role === "admin" || caller.admin,
          admin: caller.admin,
          hidden: NONE_HIDDEN,
          resource: { kind: "workspace", id: target.id, label: workspace.value.name } as const,
          ownerId: null,
          workspaceId: target.id,
          adminsOnly: false,
        };
      }
      case "account": {
        const mine = Option.exists(caller.account, (own) => own.id === target.accountId);
        if (target.accountId !== null && !mine && !caller.admin) {
          return yield* new Forbidden({
            message: "another person's settings are an admin's to see and to say",
          });
        }
        const account =
          target.accountId === null || mine
            ? yield* accountOf(caller)
            : yield* Effect.flatMap(accounts.find(target.accountId), (found) =>
                Option.isNone(found)
                  ? Effect.fail(new AccountNotFound({ id: target.accountId ?? "" }))
                  : Effect.succeed(found.value),
              );
        return {
          scopes: scopesOf({ workspaceId: null, accountId: account.id, sessionId: null }),
          pinned: false,
          // They hold for all the account has: a token held to resources reaches less.
          values: caller.resources === null,
          // A bound a person set on themselves would hold nobody but them, who lift it again.
          bounds: caller.resources === null && caller.admin,
          admin: caller.admin,
          hidden: NONE_HIDDEN,
          resource: { kind: "account", id: account.id, label: account.name } as const,
          ownerId: account.id,
          workspaceId: null,
          adminsOnly: false,
        };
      }
      case "member": {
        const { workspaceId } = target;
        const workspace = yield* workspaces.find(workspaceId);
        const role = caller.workspaces.find((one) => one.id === workspaceId)?.role ?? null;
        const held =
          caller.resources !== null && !caller.resources.workspaces.includes(workspaceId);
        if (Option.isNone(workspace) || (role === null && !caller.admin) || held) {
          return yield* new WorkspaceNotFound({ id: workspaceId });
        }
        const administers = role === "admin" || caller.admin;
        const mine =
          target.accountId === null ||
          Option.exists(caller.account, (own) => own.id === target.accountId);
        if (!mine && !administers) {
          return yield* new Forbidden({
            message: "a member's settings are for an admin of the workspace to see and to say",
          });
        }
        const member = mine
          ? yield* accountOf(caller)
          : (yield* workspaces.members(workspaceId))
              .map((one) => ({ id: one.accountId, name: one.name }))
              .find((one) => one.id === target.accountId);
        if (member === undefined || (mine && role === null)) {
          return yield* mine
            ? new WorkspaceNotFound({ id: workspaceId })
            : new AccountNotFound({ id: target.accountId ?? "" });
        }
        return {
          scopes: scopesOf({ workspaceId, accountId: member.id, sessionId: null }),
          pinned: false,
          values: caller.resources === null,
          bounds: caller.resources === null && administers,
          admin: caller.admin,
          // What the person says wherever they are is theirs and the deployment's admins'.
          hidden: mine || caller.admin ? NONE_HIDDEN : new Set<SettingLevel>(["account"]),
          resource: { kind: "account", id: member.id, label: member.name } as const,
          ownerId: member.id,
          workspaceId,
          adminsOnly: true,
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
        const acts = actsOn(caller, session, { kind: "sessions", id: session.id });
        const adminThere = caller.workspaces.some(
          (one) => one.id === session.workspaceId && one.role === "admin",
        );
        const administers = session.workspaceId === null || adminThere;
        return {
          scopes: scopesOf({
            workspaceId: session.workspaceId,
            accountId: session.accountId,
            sessionId: session.id,
          }),
          pinned: session.pinned,
          // What a session's maker says of it, or an admin of its workspace; its quotas, an admin.
          values: acts && (mine || administers),
          bounds: acts && (caller.admin || (session.workspaceId !== null && adminThere)),
          admin: caller.admin,
          // Of the owner's own levels, whoever does not read them sees what they come to.
          hidden:
            mine || caller.admin
              ? NONE_HIDDEN
              : new Set<SettingLevel>(
                  session.workspaceId !== null && adminThere ? ["account"] : ["account", "member"],
                ),
          resource: { kind: "session", id: session.id, label: session.label } as const,
          ownerId: session.accountId,
          workspaceId: session.workspaceId,
          adminsOnly: false,
        };
      }
    }
  });

  /**
   * Whether the caller says the bounds a level says of a setting: those an admin of the
   * deployment said are theirs alone.
   */
  const boundsHere = (reach: Reach, byAdmin: ReadonlySet<string>, here: Scope, key: SettingKey) =>
    reach.bounds && (reach.admin || !byAdmin.has(at(here, key)));

  const viewOf = (
    index: Index,
    byAdmin: ReadonlySet<string>,
    reach: Reach,
    key: SettingKey,
  ): SettingView => {
    const { scopes, pinned, values, hidden } = reach;
    const here = scopes[scopes.length - 1] ?? { level: "instance", scopeId: "" };
    const bounds = boundsHere(reach, byAdmin, here, key);
    const saidHere = saidAt(key, here.level);
    const entry = saidHere ? index.get(at(here, key)) : undefined;
    // Who says no bounds here is held to those of this level as to those above.
    const own = bounds ? entry : entry?.value === undefined ? undefined : { value: entry.value };
    // What it comes to is told, and where from but of the levels the caller does not read:
    // the bounds told are those of the levels they read.
    const told = (effective: SettingEffective): SettingEffective =>
      hidden.has(effective.source as SettingLevel) ? { ...effective, source: "owner" } : effective;
    const seen = scopes.filter((scope) => !hidden.has(scope.level));
    const chain = chainOf(index, seen, key);
    return {
      key,
      here: own ?? null,
      effective: told(effectiveOne(index, scopes, pinned, key)),
      inherited: told(effectiveOne(index, scopes.slice(0, -1), pinned, key)),
      above: heldBelow(
        key,
        here.level,
        boundsOf(bounds ? chain.filter((link) => link.level !== here.level) : chain),
        effectiveOne(index, seen.slice(0, -1), pinned, key),
      ),
      changeable: values && saidHere,
      bounds: bounds && saidHere,
    };
  };

  const views = Effect.fn("Policy.views")(function* (caller: Caller, target: Target) {
    const reach = yield* reached(caller, target);
    const said = yield* store.of(reach.scopes);
    const index = indexOf(said);
    const byAdmin = byAdminOf(said);
    return KEYS.map((key) => viewOf(index, byAdmin, reach, key));
  });

  const recorded = (
    kind: "setting.changed" | "setting.cleared",
    target: Target,
    reach: {
      readonly resource: EventResource | null;
      readonly ownerId: string | null;
      readonly workspaceId: string | null;
      readonly adminsOnly: boolean;
    },
    key: SettingKey,
    entry: SettingEntry,
  ) =>
    events.record({
      kind,
      resource: reach.resource,
      ownerId: reach.ownerId,
      workspaceId: reach.workspaceId,
      adminsOnly: reach.adminsOnly,
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
            : target.level === "account" || target.level === "member"
              ? "a token held to resources says nothing of an account's settings"
              : "the settings of a session are for whoever made it, or an admin of its workspace, to say",
    });

  /** Why a caller who says the values of a level does not say its bounds. */
  const boundsRefused = (target: Target, reach: Reach) =>
    new Forbidden({
      message: reach.bounds
        ? "these bounds were said by an admin of the deployment, and are theirs to change"
        : target.level === "member"
          ? "the bounds of a member's settings are for an admin of the workspace to say"
          : target.level === "account"
            ? "the bounds of a person's settings are an admin's to say"
            : "the bounds of a session's settings are for an admin to say",
    });

  const set = Effect.fn("Policy.set")(function* (
    caller: Caller,
    target: Target,
    key: SettingKey,
    entry: SettingEntry,
  ) {
    const reach = yield* reached(caller, target);
    if (!reach.values) {
      return yield* refusedHere(target);
    }
    const here = reach.scopes[reach.scopes.length - 1] ?? { level: "instance", scopeId: "" };
    const kept = yield* store.of(reach.scopes);
    const before = indexOf(kept);
    const byAdmin = byAdminOf(kept);
    const chain = chainOf(before, reach.scopes, key);
    const there = before.get(at(here, key));
    const inherited = effectiveOne(before, reach.scopes.slice(0, -1), reach.pinned, key);
    let said = entry;
    let above = boundsOf(chain.filter((link) => link.level !== here.level));
    if (!boundsHere(reach, byAdmin, here, key) && saidAt(key, here.level)) {
      if (boundsChange(entry, there)) {
        return yield* boundsRefused(target, reach);
      }
      // The value alone is theirs: the bounds stay, and hold it as those above do.
      said = { ...(entry.value === undefined ? {} : { value: entry.value }), ...boundsPart(there) };
      above = boundsOf(chain);
    } else if (
      isQuota(key) &&
      PERSONAL.includes(here.level) &&
      typeof entry.value === "number" &&
      entry.max === undefined
    ) {
      // What an admin gives a person is the most they have: they say less, and no more.
      said = { ...entry, max: entry.value };
    }
    const checked = check(key, here.level, said, heldBelow(key, here.level, above, inherited));
    if (Result.isFailure(checked)) {
      return yield* checked.failure;
    }
    if (said.value === null && noneOverNode(key, here.level, inherited)) {
      return yield* new SettingOutOfBounds({
        key,
        level: "instance",
        message: `each node holds ${key} to its own, and no level below the instance says no limit past it`,
      });
    }
    yield* written(here, key, said, reach.admin || byAdmin.has(at(here, key)));
    yield* recorded("setting.changed", target, reach, key, said);
    yield* touched();
    return yield* viewAfter(reach, key);
  });

  /**
   * Writes what a level says of a setting, or that it says nothing. Its bounds are an
   * admin's of the deployment where one says them, and stay so where another says the
   * value inside them.
   */
  const written = (here: Scope, key: SettingKey, said: SettingEntry, byAdmin: boolean) =>
    Effect.gen(function* () {
      if (saysSomething(said)) {
        yield* store.put(
          { ...here, key, entry: said, byAdmin: byAdmin && saysSomething(boundsPart(said)) },
          yield* now,
        );
      } else {
        yield* store.remove(here, key);
      }
    });

  const viewAfter = (reach: Reach, key: SettingKey) =>
    Effect.map(store.of(reach.scopes), (said) =>
      viewOf(indexOf(said), byAdminOf(said), reach, key),
    );

  const clear = Effect.fn("Policy.clear")(function* (
    caller: Caller,
    target: Target,
    key: SettingKey,
  ) {
    const reach = yield* reached(caller, target);
    if (!reach.values) {
      return yield* refusedHere(target);
    }
    const here = reach.scopes[reach.scopes.length - 1] ?? { level: "instance", scopeId: "" };
    const there = yield* store.of([here]);
    const byAdmin = byAdminOf(there);
    const kept = boundsHere(reach, byAdmin, here, key)
      ? {}
      : boundsPart(indexOf(there).get(at(here, key)));
    // Who says no bounds clears the value alone.
    yield* written(here, key, kept, byAdmin.has(at(here, key)));
    yield* recorded("setting.cleared", target, reach, key, kept);
    yield* touched();
    return yield* viewAfter(reach, key);
  });

  const of = Effect.fn("Policy.of")(function* (place: Place) {
    const scopes = scopesOf(place);
    return effectiveOf(indexOf(yield* store.of(scopes)), scopes, place.pinned);
  });

  const snapshot = Effect.fn("Policy.snapshot")(function* () {
    const index = indexOf(yield* store.all());
    return (place: Place) => effectiveOf(index, scopesOf(place), place.pinned);
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
