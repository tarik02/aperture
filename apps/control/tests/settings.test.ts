import {
  type Offers,
  SETTINGS,
  type SettingKey,
  type SettingView,
} from "@aperture-browser/control-api";
import { suite } from "@aperture-browser/e2e/src/suite.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import { awake, boundsOf, check, noneOverNode, resolve } from "../src/policy/cascade.ts";
import { limitsOf } from "../src/policy/limits.ts";
import type { Effective } from "../src/policy/service.ts";
import { SessionsStore } from "../src/sessions/store.ts";
import * as Control from "./src/control.ts";
import * as Stores from "./src/stores.ts";

const configured = { value: undefined, source: "default" } as const;

describe("what a setting comes to", () => {
  it("is what the nearest level says, and the base where none does", () => {
    const chain = [
      { level: "instance", entry: { value: 3600 } },
      { level: "workspace", entry: undefined },
      { level: "account", entry: { value: 600 } },
      { level: "session", entry: undefined },
    ] as const;
    expect(resolve("deleteSuspendedAfter", chain, configured)).toEqual({
      value: 600,
      source: "account",
      locked: false,
      clamped: false,
      perNode: false,
    });
    expect(
      resolve("deleteSuspendedAfter", [{ level: "instance", entry: undefined }], {
        value: 86_400,
        source: "configuration",
      }),
    ).toMatchObject({ value: 86_400, source: "configuration" });
    // What each node has, where nobody says anything.
    expect(resolve("suspendIdleAfter", [], configured)).toMatchObject({
      value: null,
      source: "node",
    });
  });

  it("is held to every bound on the way, and said to come from the level that sets it", () => {
    const tightened = [
      { level: "instance", entry: { max: 7200 } },
      { level: "workspace", entry: { value: 3600, max: 1800 } },
      { level: "account", entry: { value: 86_400 } },
    ] as const;
    expect(resolve("maxSessionAge", tightened, configured)).toEqual({
      value: 1800,
      source: "workspace",
      locked: false,
      clamped: true,
      perNode: false,
    });
    // Never is past any bound of most.
    const never = [
      { level: "instance", entry: { max: 7200 } },
      { level: "account", entry: { value: null } },
    ] as const;
    expect(resolve("maxSessionAge", never, configured)).toMatchObject({
      value: 7200,
      source: "instance",
      clamped: true,
    });
    // Nothing said, and a bound of most: the node's own may be past it.
    expect(
      resolve("suspendIdleAfter", [{ level: "workspace", entry: { max: 900 } }], configured),
    ).toMatchObject({ value: 900, source: "workspace" });
    const locked = [
      { level: "instance", entry: { min: 600, max: 600 } },
      { level: "session", entry: { value: 60 } },
    ] as const;
    expect(resolve("suspendIdleAfter", locked, configured)).toEqual({
      value: 600,
      source: "instance",
      locked: true,
      clamped: true,
      perNode: false,
    });
  });

  it("is never deleted by a bound alone, where no level says when", () => {
    for (const key of ["maxSessionAge", "deleteSuspendedAfter"] as const) {
      expect(
        resolve(key, [{ level: "instance", entry: { max: 2_592_000 } }], {
          value: null,
          source: "default",
        }),
      ).toMatchObject({ value: null, source: "default", clamped: false });
      expect(
        resolve(key, [{ level: "workspace", entry: { min: 60, max: 60 } }], {
          value: null,
          source: "configuration",
        }),
      ).toMatchObject({ value: null, source: "configuration" });
    }
  });

  it("does not get past a lock above with a bound saved below it", () => {
    const lock = { level: "workspace", entry: { min: 7_776_000, max: 7_776_000 } } as const;
    const under = [lock, { level: "session", entry: { value: 1, max: 1 } }] as const;
    expect(boundsOf(under)).toEqual({
      min: { value: 7_776_000, level: "workspace" },
      max: { value: 7_776_000, level: "workspace" },
      allowed: null,
    });
    expect(resolve("maxSessionAge", under, configured)).toMatchObject({
      value: 7_776_000,
      source: "workspace",
      locked: true,
    });
    const over = [
      { level: "instance", entry: { max: 3600 } },
      { level: "account", entry: { min: 86_400 } },
    ] as const;
    expect(boundsOf(over).min).toEqual({ value: 3600, level: "instance" });
  });

  it("keeps a pinned session awake no longer than a bound above lets it sit idle", () => {
    const stays = {
      value: true,
      source: "workspace",
      locked: false,
      clamped: false,
      perNode: false,
    } as const;
    expect(awake([{ level: "instance", entry: { value: 600 } }], stays)).toMatchObject({
      value: null,
      source: "workspace",
    });
    expect(awake([{ level: "instance", entry: { max: 3600 } }], stays)).toMatchObject({
      value: 3600,
      source: "instance",
      clamped: true,
    });
  });

  it("is a quota no greater than what the levels above make of it", () => {
    const given = [
      { level: "instance", entry: { value: 5 } },
      { level: "workspace", entry: { value: 10 } },
      { level: "account", entry: { value: 3 } },
      { level: "member", entry: { value: null } },
    ] as const;
    expect(resolve("runningSessions", given.slice(0, 2), configured)).toEqual({
      value: 5,
      source: "instance",
      locked: false,
      clamped: true,
      perNode: false,
    });
    expect(resolve("runningSessions", given, configured)).toMatchObject({
      value: 3,
      source: "account",
      clamped: true,
    });
    // The deployment's says otherwise than the environment, either way.
    expect(
      resolve("runningSessions", [{ level: "instance", entry: { value: 9 } }], {
        value: 4,
        source: "configuration",
      }),
    ).toMatchObject({ value: 9, source: "instance" });
    expect(
      resolve("runningSessions", [{ level: "workspace", entry: { value: 9 } }], {
        value: 4,
        source: "configuration",
      }),
    ).toMatchObject({ value: 4, source: "instance", clamped: true });
  });

  it("is a choice that is allowed, the nearest one above where the nearest is not", () => {
    const narrowed = [
      { level: "instance", entry: { value: "admins" } },
      { level: "workspace", entry: { value: "anyone", allowed: ["admins", "nobody"] } },
    ] as const;
    expect(resolve("pinning", narrowed, { value: "admins", source: "default" })).toEqual({
      value: "admins",
      source: "instance",
      locked: false,
      clamped: true,
      perNode: false,
    });
    const none = [{ level: "instance", entry: { value: "anyone", allowed: ["nobody"] } }] as const;
    expect(resolve("pinning", none, { value: "anyone", source: "default" })).toEqual({
      value: "nobody",
      source: "instance",
      locked: true,
      clamped: true,
      perNode: false,
    });
  });
});

describe("a lower level only narrows", () => {
  const gib = 1024 ** 3;

  it("keeps a node's own memory and processors where the deployment says none", () => {
    const below = [
      { level: "instance", entry: undefined },
      { level: "workspace", entry: { value: 2 * gib } },
      { level: "member", entry: { value: null } },
    ] as const;
    // No limit said below is passed by; a number is held to the node's own as well.
    expect(resolve("sessionMemory", below, configured)).toEqual({
      value: 2 * gib,
      source: "workspace",
      locked: false,
      clamped: true,
      perNode: true,
    });
    expect(
      resolve("sessionCpus", [{ level: "account", entry: { value: null } }], configured),
    ).toMatchObject({ value: null, source: "node", clamped: true, perNode: false });
    // The deployment says otherwise than its nodes, no limit too.
    const unlimited = [
      { level: "instance", entry: { value: null } },
      { level: "account", entry: { value: null } },
    ] as const;
    expect(resolve("sessionMemory", unlimited, configured)).toMatchObject({
      value: null,
      source: "account",
      perNode: false,
    });
    expect(
      resolve("sessionMemory", [{ level: "account", entry: { value: gib } }], {
        value: 4 * gib,
        source: "configuration",
      }),
    ).toMatchObject({ value: gib, source: "account", perNode: false });
    const nodes = {
      value: null,
      source: "node",
      locked: false,
      clamped: false,
      perNode: false,
    } as const;
    expect(noneOverNode("sessionMemory", "account", nodes)).toBe(true);
    expect(noneOverNode("sessionMemory", "instance", nodes)).toBe(false);
    // What a node has of its own sessions sit idle as long as is said otherwise.
    expect(noneOverNode("suspendIdleAfter", "account", nodes)).toBe(false);
  });

  it("gives a node no more than its own of what only a level below the deployment says", () => {
    const left = {
      value: null,
      source: "node",
      locked: false,
      clamped: false,
      perNode: false,
    } as const;
    const effective = {
      ...(Object.fromEntries(Object.keys(SETTINGS).map((key) => [key, left])) as Effective),
      sessionMemory: { ...left, value: 8 * gib, source: "workspace", perNode: true },
      sessionCpus: { ...left, value: 4, source: "instance" },
    } satisfies Effective;
    const node = (limits: Offers["limits"]) => ({
      offers: {
        version: "",
        features: [],
        network: { tcp: "", udp: "" },
        limits,
        holdsResources: true,
        sharesSnapshots: false,
      },
    });
    expect(limitsOf(effective, node({ memoryBytes: 2 * gib, cpus: 1 }))).toEqual({
      memoryBytes: BigInt(2 * gib),
      cpus: 4,
    });
    expect(limitsOf(effective, node({}))).toEqual({ memoryBytes: BigInt(8 * gib), cpus: 4 });
  });

  it("does not undo a lock on a choice with the choices allowed below it", () => {
    const chain = [
      { level: "instance", entry: { value: "off", allowed: ["off"] } },
      { level: "workspace", entry: { allowed: ["rw", "ro"] } },
      { level: "session", entry: { value: "rw" } },
    ] as const;
    expect(boundsOf(chain).allowed).toEqual({ values: ["off"], level: "instance" });
    expect(resolve("clipboard", chain, { value: "rw", source: "default" })).toMatchObject({
      value: "off",
      source: "instance",
      locked: true,
    });
    // What is left of those above is what is allowed.
    const narrowed = [
      { level: "instance", entry: { allowed: ["rw", "ro"] } },
      { level: "workspace", entry: { allowed: ["ro", "off"] } },
    ] as const;
    expect(boundsOf(narrowed).allowed).toEqual({ values: ["ro"], level: "workspace" });
  });
});

describe("what a level may say of a setting", () => {
  const above = boundsOf([
    { level: "instance", entry: { max: 7200 } },
    { level: "workspace", entry: { min: 600 } },
  ]);
  const refused = (result: ReturnType<typeof check>) =>
    Result.isFailure(result) ? result.failure : undefined;

  it("is refused past a bound above, naming the level that sets it", () => {
    expect(refused(check("maxSessionAge", "account", { value: 9000 }, above))).toMatchObject({
      _tag: "SettingOutOfBounds",
      level: "instance",
    });
    expect(refused(check("maxSessionAge", "account", { value: 60 }, above))).toMatchObject({
      _tag: "SettingOutOfBounds",
      level: "workspace",
    });
    expect(refused(check("maxSessionAge", "account", { value: null }, above))).toMatchObject({
      _tag: "SettingOutOfBounds",
      level: "instance",
    });
    // A bound below may be narrower than those above, and no wider.
    expect(refused(check("maxSessionAge", "account", { max: 9000 }, above))).toMatchObject({
      _tag: "SettingOutOfBounds",
      level: "instance",
    });
    // Nor past the other end.
    expect(refused(check("maxSessionAge", "account", { max: 60 }, above))).toMatchObject({
      _tag: "SettingOutOfBounds",
      level: "workspace",
    });
    expect(refused(check("maxSessionAge", "account", { min: 9000 }, above))).toMatchObject({
      _tag: "SettingOutOfBounds",
      level: "instance",
    });
    expect(
      Result.isSuccess(check("maxSessionAge", "account", { value: 3600, max: 3600 }, above)),
    ).toBe(true);
    const choices = boundsOf([{ level: "instance", entry: { allowed: ["admins", "nobody"] } }]);
    expect(refused(check("pinning", "workspace", { value: "anyone" }, choices))).toMatchObject({
      _tag: "SettingOutOfBounds",
      level: "instance",
    });
    expect(refused(check("pinning", "workspace", { allowed: ["anyone"] }, choices))).toMatchObject({
      _tag: "SettingOutOfBounds",
      level: "instance",
    });
  });

  it("is refused where it is not of the setting's kind, or not said at that level", () => {
    const none = boundsOf([]);
    for (const [key, level, entry] of [
      ["purgeDeletedAfter", "workspace", { value: 3600 }],
      ["maxSessionAge", "account", { value: 1.5 }],
      ["maxSessionAge", "account", { value: "an hour" }],
      ["maxSessionAge", "account", { allowed: [60] }],
      ["maxSessionAge", "account", { min: 600, max: 60 }],
      ["maxSessionAge", "account", { value: 6000, max: 600 }],
      ["pinning", "workspace", { value: "everyone" }],
      ["pinning", "workspace", { min: 1 }],
      ["maxPinnedSessions", "workspace", { value: -1 }],
      ["sessionsPerWorkspace", "account", { value: 3 }],
      ["apiTokenMaxLifetime", "member", { value: 3600 }],
      ["sessionMemory", "session", { value: 0.5 }],
      ["sessionCpus", "session", { value: 0 }],
    ] as const) {
      expect(
        refused(check(key, level, entry, none)),
        `${key} ${JSON.stringify(entry)}`,
      ).toMatchObject({
        _tag: "SettingInvalid",
      });
    }
  });
});

suite(Control.layer())("settings over the API", (it) => {
  it.effect(
    "each level is held to the bounds above it, and told where what it has comes from",
    () =>
      Effect.gen(function* () {
        const control = yield* Control.Control;
        const root = yield* control.as(control.bootstrapToken);
        const ada = yield* Control.account("Ada");
        const bea = yield* Control.account("Bea");
        const team = yield* ada.api.workspaces.create({ payload: { name: "Team" } });
        yield* ada.api.workspaces.admit({
          params: { id: team.id, accountId: bea.account.id },
          payload: { role: "member" },
        });

        // The deployment's are an admin's to say, and anyone's to read.
        const notAdmin = yield* Effect.flip(
          ada.api.settings.setInstance({
            params: { key: "maxSessionAge" },
            payload: { max: 86_400 },
          }),
        );
        expect(notAdmin._tag).toBe("Forbidden");
        yield* root.settings.setInstance({
          params: { key: "maxSessionAge" },
          payload: { max: 86_400 },
        });
        const read = yield* bea.api.settings.instance();
        // Who says no bounds there is told them as those that hold them.
        expect(read.settings.find((one) => one.key === "maxSessionAge")).toMatchObject({
          here: null,
          above: { max: { value: 86_400, level: "instance" } },
          changeable: false,
          bounds: false,
        });

        const at = { id: team.id, key: "maxSessionAge" } as const;
        const beyond = yield* Effect.flip(
          ada.api.settings.setWorkspace({ params: at, payload: { value: 172_800 } }),
        );
        expect(beyond).toMatchObject({ _tag: "SettingOutOfBounds", level: "instance" });
        const set = yield* ada.api.settings.setWorkspace({
          params: at,
          payload: { value: 3600, max: 7200 },
        });
        expect(set).toMatchObject({
          effective: { value: 3600, source: "workspace", clamped: false },
          above: { max: { value: 86_400, level: "instance" } },
        });
        // A workspace's are its admins' to say, and its members' to read.
        const member = yield* Effect.flip(
          bea.api.settings.setWorkspace({ params: at, payload: { value: 600 } }),
        );
        expect(member._tag).toBe("Forbidden");
        expect(
          (yield* bea.api.settings.workspace({ params: { id: team.id } })).settings.find(
            (one) => one.key === "maxSessionAge",
          )?.effective,
        ).toMatchObject({ value: 3600, source: "workspace" });

        // A person says their own as a member of the workspace, below it.
        const inTeam = { workspaceId: team.id };
        const mine = yield* Effect.flip(
          bea.api.settings.setAccount({
            params: { key: "maxSessionAge" },
            query: inTeam,
            payload: { value: 9000 },
          }),
        );
        expect(mine).toMatchObject({ _tag: "SettingOutOfBounds", level: "workspace" });
        const own = yield* bea.api.settings.setAccount({
          params: { key: "maxSessionAge" },
          query: inTeam,
          payload: { value: 5400 },
        });
        expect(own.effective).toMatchObject({ value: 5400, source: "member" });
        // Of what is their own, the workspace's bounds do not hold, nor what they said in it.
        const apart = yield* bea.api.settings.setAccount({
          params: { key: "maxSessionAge" },
          query: {},
          payload: { value: 9000 },
        });
        expect(apart.effective).toMatchObject({ value: 9000, source: "account" });
        // What they say wherever they are holds in the workspace below what they say there.
        const cleared = yield* bea.api.settings.clearAccount({
          params: { key: "maxSessionAge" },
          query: inTeam,
        });
        expect(cleared.effective).toMatchObject({
          value: 7200,
          source: "workspace",
          clamped: true,
        });
        yield* bea.api.settings.setAccount({
          params: { key: "maxSessionAge" },
          query: inTeam,
          payload: { value: 5400 },
        });

        // A bound set after a value below it holds over that value.
        yield* ada.api.settings.setWorkspace({ params: at, payload: { value: 1200, max: 1800 } });
        expect(
          (yield* bea.api.settings.account({ query: inTeam })).settings.find(
            (one) => one.key === "maxSessionAge",
          )?.effective,
        ).toMatchObject({ value: 1800, source: "workspace", clamped: true });

        // A session of the workspace has what is said on the way to it; one with a lock
        // takes nothing else.
        yield* control.sql`
        INSERT INTO sessions (
          id, account_id, workspace_id, desired_state, observed_state, created_at, observed_at
        )
        VALUES ('settled', ${bea.account.id}, ${team.id}, 'suspended', 'suspended', now(), now())
      `;
        yield* ada.api.settings.setWorkspace({
          params: { id: team.id, key: "suspendIdleAfter" },
          payload: { min: 900, max: 900 },
        });
        const locked = yield* Effect.flip(
          bea.api.settings.setSession({
            params: { id: "settled", key: "suspendIdleAfter" },
            payload: { value: 60 },
          }),
        );
        expect(locked).toMatchObject({ _tag: "SettingOutOfBounds", level: "workspace" });
        const session = yield* bea.api.settings.session({ params: { id: "settled" } });
        expect(session.settings.find((one) => one.key === "suspendIdleAfter")).toMatchObject({
          effective: { value: 900, source: "workspace", locked: true },
          changeable: true,
        });
        expect(
          session.settings.find((one) => one.key === "maxSessionAge")?.effective,
        ).toMatchObject({
          value: 1800,
          source: "workspace",
        });
        // An admin of the workspace says it too.
        const theirs = yield* ada.api.settings.session({ params: { id: "settled" } });
        expect(theirs.settings.find((one) => one.key === "maxSessionAge")?.changeable).toBe(true);
        const gone = yield* ada.api.settings.clearWorkspace({ params: at });
        expect(gone.here).toBeNull();
      }),
  );

  it.effect("an admin holds a person to bounds they neither cross nor clear", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const root = yield* control.as(control.bootstrapToken);
      const admin = yield* Control.account("Admiral", true);
      const cy = yield* Control.account("Cy");
      const theirs = { accountId: cy.account.id };

      // An admin says a person's values and bounds wherever they are.
      const said = yield* admin.api.settings.setPerson({
        params: { ...theirs, key: "maxSessionAge" },
        payload: { value: 3600, max: 7200 },
      });
      expect(said).toMatchObject({
        here: { value: 3600, max: 7200 },
        effective: { value: 3600, source: "account" },
        changeable: true,
        bounds: true,
      });
      yield* admin.api.settings.setPerson({
        params: { ...theirs, key: "runningSessions" },
        payload: { value: 2 },
      });

      // The person reads what was said for them, the bounds as those above theirs.
      const read = (yield* cy.api.settings.account({ query: {} })).settings;
      expect(read.find((one) => one.key === "maxSessionAge")).toMatchObject({
        here: { value: 3600 },
        above: { max: { value: 7200, level: "account" } },
        changeable: true,
        bounds: false,
      });
      // An admin's quota, said as a value alone, is the most the person has.
      expect(read.find((one) => one.key === "runningSessions")).toMatchObject({
        here: { value: 2 },
        effective: { value: 2, source: "account" },
        above: { max: { value: 2, level: "account" } },
        changeable: true,
      });

      // They say their own value inside the bound, and none past it.
      const beyond = yield* Effect.flip(
        cy.api.settings.setAccount({
          params: { key: "maxSessionAge" },
          query: {},
          payload: { value: 86_400 },
        }),
      );
      expect(beyond).toMatchObject({ _tag: "SettingOutOfBounds", level: "account" });
      const inside = yield* cy.api.settings.setAccount({
        params: { key: "maxSessionAge" },
        query: {},
        payload: { value: 5400 },
      });
      expect(inside).toMatchObject({ here: { value: 5400 }, effective: { value: 5400 } });
      // Clearing it clears their value alone: the bound stays.
      const cleared = yield* cy.api.settings.clearAccount({
        params: { key: "maxSessionAge" },
        query: {},
      });
      expect(cleared).toMatchObject({ here: null, above: { max: { value: 7200 } } });
      expect(
        (yield* admin.api.settings.person({ params: theirs })).settings.find(
          (one) => one.key === "maxSessionAge",
        )?.here,
      ).toEqual({ max: 7200 });

      // What the admin did is told as theirs, of the person, to the person as well.
      const { events } = yield* cy.api.events.list({ query: { resourceId: cy.account.id } });
      expect(
        events
          .filter((event) => event.kind === "setting.changed")
          .map((event) => [event.actor.id ?? null, event.resource?.id]),
      ).toEqual([
        [cy.account.id, cy.account.id],
        [admin.account.id, cy.account.id],
        [admin.account.id, cy.account.id],
      ]);

      // Nor do they set bounds on themselves.
      for (const payload of [{ max: 86_400 }, { value: 3600, max: 3600 }]) {
        const bound = yield* Effect.flip(
          cy.api.settings.setAccount({ params: { key: "maxSessionAge" }, query: {}, payload }),
        );
        expect(bound._tag, JSON.stringify(payload)).toBe("Forbidden");
      }

      // A quota they lower, and raise again as far as the admin's, and no further.
      const running = (value: number | null) =>
        cy.api.settings.setAccount({
          params: { key: "runningSessions" },
          query: {},
          payload: { value },
        });
      expect((yield* running(1)).effective).toMatchObject({ value: 1, source: "account" });
      expect((yield* running(2)).effective).toMatchObject({ value: 2, source: "account" });
      for (const value of [3, null]) {
        expect(yield* Effect.flip(running(value)), String(value)).toMatchObject({
          _tag: "SettingOutOfBounds",
          level: "account",
        });
      }
      // Cleared, theirs is the admin's most again.
      expect(
        (yield* cy.api.settings.clearAccount({ params: { key: "runningSessions" }, query: {} }))
          .effective,
      ).toMatchObject({ value: 2, source: "account" });
      // As a member of a workspace, theirs there is held to it as well: no limit is no less.
      const team = yield* admin.api.workspaces.create({ payload: { name: "Cy's" } });
      yield* admin.api.workspaces.admit({
        params: { id: team.id, accountId: cy.account.id },
        payload: { role: "member" },
      });
      const there = (value: number | null) =>
        cy.api.settings.setAccount({
          params: { key: "runningSessions" },
          query: { workspaceId: team.id },
          payload: { value },
        });
      expect((yield* there(1)).effective).toMatchObject({ value: 1, source: "member" });
      for (const value of [3, null]) {
        expect(yield* Effect.flip(there(value)), String(value)).toMatchObject({
          _tag: "SettingOutOfBounds",
          level: "account",
        });
      }
      expect((yield* root.settings.person({ params: theirs })).settings.length).toBeGreaterThan(0);
    }),
  );

  it.effect("a workspace's admin says what its members have there, and nowhere else", () =>
    Effect.gen(function* () {
      const dee = yield* Control.account("Dee");
      const eli = yield* Control.account("Eli");
      const fay = yield* Control.account("Fay");
      const ours = yield* dee.api.workspaces.create({ payload: { name: "Ours" } });
      const elsewhere = yield* fay.api.workspaces.create({ payload: { name: "Elsewhere" } });
      for (const [id, admitted] of [
        [ours.id, eli],
        [elsewhere.id, eli],
        [elsewhere.id, dee],
      ] as const) {
        yield* (id === ours.id ? dee : fay).api.workspaces.admit({
          params: { id, accountId: admitted.account.id },
          payload: { role: "member" },
        });
      }
      const eliIn = (id: string) => ({ id, accountId: eli.account.id });

      const said = yield* dee.api.settings.setMember({
        params: { ...eliIn(ours.id), key: "sessionsPerUser" },
        payload: { value: 3, max: 3 },
      });
      expect(said.effective).toMatchObject({ value: 3, source: "member" });
      // The member reads it there, and changes nothing of it.
      const theirs = (yield* eli.api.settings.account({ query: { workspaceId: ours.id } }))
        .settings;
      expect(theirs.find((one) => one.key === "sessionsPerUser")).toMatchObject({
        effective: { value: 3, source: "member" },
        above: { max: { value: 3, level: "member" } },
        changeable: true,
      });
      // It holds in that workspace alone.
      expect(
        (yield* eli.api.settings.account({ query: { workspaceId: elsewhere.id } })).settings.find(
          (one) => one.key === "sessionsPerUser",
        )?.effective.source,
      ).not.toBe("member");

      // Where they are a member and no admin, they say nothing of another, nor read it.
      const notAdmin = yield* Effect.flip(
        dee.api.settings.setMember({
          params: { ...eliIn(elsewhere.id), key: "sessionsPerUser" },
          payload: { value: 1 },
        }),
      );
      expect(notAdmin._tag).toBe("Forbidden");
      const notRead = yield* Effect.flip(dee.api.settings.member({ params: eliIn(elsewhere.id) }));
      expect(notRead._tag).toBe("Forbidden");
      // Nor in a workspace they are not in at all.
      const outside = yield* Effect.flip(
        eli.api.settings.member({ params: { id: ours.id, accountId: dee.account.id } }),
      );
      expect(outside._tag).toBe("Forbidden");
      const stranger = yield* Control.account("Gus");
      const unseen = yield* Effect.flip(stranger.api.settings.member({ params: eliIn(ours.id) }));
      expect(unseen._tag).toBe("WorkspaceNotFound");
      // Of someone who is no member, there is nothing to say.
      const none = yield* Effect.flip(
        dee.api.settings.member({ params: { id: ours.id, accountId: fay.account.id } }),
      );
      expect(none._tag).toBe("AccountNotFound");
    }),
  );

  it.effect("nobody but an admin reads or says another person's settings", () =>
    Effect.gen(function* () {
      const hal = yield* Control.account("Hal");
      const ivy = yield* Control.account("Ivy");
      const ivys = { accountId: ivy.account.id };
      const read = yield* Effect.flip(hal.api.settings.person({ params: ivys }));
      expect(read._tag).toBe("Forbidden");
      const set = yield* Effect.flip(
        hal.api.settings.setPerson({
          params: { ...ivys, key: "clipboard" },
          payload: { value: "off" },
        }),
      );
      expect(set._tag).toBe("Forbidden");
      const cleared = yield* Effect.flip(
        hal.api.settings.clearPerson({ params: { ...ivys, key: "clipboard" } }),
      );
      expect(cleared._tag).toBe("Forbidden");
      // Their own, by their id, they read as at their own.
      const own = yield* ivy.api.settings.person({ params: ivys });
      expect(own.settings.find((one) => one.key === "clipboard")?.bounds).toBe(false);
    }),
  );
  it.effect("no level below the deployment lifts a node's own limit", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const root = yield* control.as(control.bootstrapToken);
      const jo = yield* Control.account("Jo");
      const memory = (value: number | null) =>
        jo.api.settings.setAccount({
          params: { key: "sessionMemory" },
          query: {},
          payload: { value },
        });
      expect(yield* Effect.flip(memory(null))).toMatchObject({
        _tag: "SettingOutOfBounds",
        level: "instance",
      });
      // Less they say, and each node holds them to its own where that is less still.
      expect((yield* memory(1024 ** 3)).effective).toMatchObject({
        value: 1024 ** 3,
        source: "account",
        perNode: true,
      });
      // Where the deployment says no limit, so may they.
      yield* root.settings.setInstance({
        params: { key: "sessionMemory" },
        payload: { value: null },
      });
      expect((yield* memory(null)).effective).toMatchObject({
        value: null,
        source: "account",
        perNode: false,
      });
      yield* root.settings.clearInstance({ params: { key: "sessionMemory" } });
      // What they said before is passed by: the node's own holds.
      expect(
        (yield* jo.api.settings.account({ query: {} })).settings.find(
          (one) => one.key === "sessionMemory",
        )?.effective,
      ).toMatchObject({ value: null, source: "node" });
    }),
  );

  it.effect("what is said of a member is not told to the other members", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const kai = yield* Control.account("Kai");
      const lu = yield* Control.account("Lu");
      const mo = yield* Control.account("Mo");
      const team = yield* kai.api.workspaces.create({ payload: { name: "Kai's" } });
      for (const admitted of [lu, mo]) {
        yield* kai.api.workspaces.admit({
          params: { id: team.id, accountId: admitted.account.id },
          payload: { role: "member" },
        });
      }
      // Lu says theirs wherever they are and in the workspace; its admin bounds them there.
      yield* lu.api.settings.setAccount({
        params: { key: "clipboard" },
        query: {},
        payload: { value: "ro" },
      });
      yield* lu.api.settings.setAccount({
        params: { key: "uploads" },
        query: { workspaceId: team.id },
        payload: { value: false },
      });
      yield* kai.api.settings.setMember({
        params: { id: team.id, accountId: lu.account.id, key: "maxSessionAge" },
        payload: { max: 3600 },
      });

      const said = (events: ReadonlyArray<{ readonly kind: string; readonly detail: unknown }>) =>
        events.filter(
          (event) =>
            event.kind === "setting.changed" &&
            (event.detail as { readonly level?: string }).level === "member",
        ).length;
      const of = (who: typeof kai) => who.api.events.list({ query: { workspaceId: team.id } });
      expect(said((yield* of(mo)).events)).toBe(0);
      expect(said((yield* of(lu)).events)).toBe(2);
      expect(said((yield* of(kai)).events)).toBe(2);

      yield* control.sql`
        INSERT INTO sessions (
          id, account_id, workspace_id, desired_state, observed_state, created_at, observed_at
        )
        VALUES ('lus', ${lu.account.id}, ${team.id}, 'suspended', 'suspended', now(), now())
      `;
      const seen = (settings: ReadonlyArray<SettingView>, key: SettingKey) =>
        settings.find((one) => one.key === key);
      // To another member, what comes from Lu's own levels comes from its owner, unbounded.
      const others = (yield* mo.api.settings.session({ params: { id: "lus" } })).settings;
      expect(seen(others, "clipboard")?.effective).toMatchObject({ value: "ro", source: "owner" });
      expect(seen(others, "uploads")?.effective).toMatchObject({ value: false, source: "owner" });
      expect(seen(others, "maxSessionAge")?.above.max?.level).not.toBe("member");
      // The workspace's admin reads the member's, and not what Lu says wherever they are.
      const admins = (yield* kai.api.settings.session({ params: { id: "lus" } })).settings;
      expect(seen(admins, "clipboard")?.effective.source).toBe("owner");
      expect(seen(admins, "uploads")?.effective.source).toBe("member");
      expect(seen(admins, "maxSessionAge")?.above.max).toEqual({ value: 3600, level: "member" });
      const own = (yield* lu.api.settings.session({ params: { id: "lus" } })).settings;
      expect(seen(own, "clipboard")?.effective.source).toBe("account");

      // What is said of the session is of whoever owns it.
      yield* lu.api.settings.setSession({
        params: { id: "lus", key: "downloads" },
        payload: { value: false },
      });
      expect(
        yield* control.sql`
          SELECT owner_id AS owner FROM events
          WHERE kind = 'setting.changed' AND resource_id = 'lus'
        `,
      ).toEqual([{ owner: lu.account.id }]);
    }),
  );

  it.effect("the bounds an admin sets in a workspace are not its admins' to lift", () =>
    Effect.gen(function* () {
      const admin = yield* Control.account("Overseer", true);
      const nia = yield* Control.account("Nia");
      const team = yield* nia.api.workspaces.create({ payload: { name: "Nia's" } });
      const at = { id: team.id, key: "maxSessionAge" } as const;
      yield* admin.api.settings.setWorkspace({ params: at, payload: { value: 3600, max: 7200 } });

      // Its admin neither widens them nor says others, and says the value inside them.
      for (const payload of [{ max: 86_400 }, { max: 3600 }]) {
        const refused = yield* Effect.flip(nia.api.settings.setWorkspace({ params: at, payload }));
        expect(refused._tag, JSON.stringify(payload)).toBe("Forbidden");
      }
      const theirs = yield* nia.api.settings.setWorkspace({ params: at, payload: { value: 1800 } });
      expect(theirs).toMatchObject({
        here: { value: 1800 },
        above: { max: { value: 7200, level: "workspace" } },
        bounds: false,
      });
      expect(
        yield* Effect.flip(nia.api.settings.setWorkspace({ params: at, payload: { value: 9000 } })),
      ).toMatchObject({ _tag: "SettingOutOfBounds", level: "workspace" });
      // Clearing it clears their value alone.
      yield* nia.api.settings.clearWorkspace({ params: at });
      const left = (yield* admin.api.settings.workspace({ params: { id: team.id } })).settings;
      expect(left.find((one) => one.key === "maxSessionAge")).toMatchObject({
        here: { max: 7200 },
        bounds: true,
      });

      // Nor does an admin of the workspace lift what the admin held them to as a member.
      const own = { id: team.id, accountId: nia.account.id, key: "sessionsPerUser" } as const;
      yield* admin.api.settings.setMember({ params: own, payload: { max: 2 } });
      expect(
        (yield* Effect.flip(nia.api.settings.setMember({ params: own, payload: { max: 5 } })))._tag,
      ).toBe("Forbidden");
      yield* nia.api.settings.clearMember({ params: own });
      expect(
        (yield* admin.api.settings.member({
          params: { id: team.id, accountId: nia.account.id },
        })).settings.find((one) => one.key === "sessionsPerUser")?.here,
      ).toEqual({ max: 2 });

      // What the admin clears is theirs again.
      yield* admin.api.settings.clearWorkspace({ params: at });
      expect(
        (yield* nia.api.settings.setWorkspace({ params: at, payload: { max: 86_400 } })).bounds,
      ).toBe(true);
    }),
  );

  it.effect("a session its node lost is deleted with no node to ask", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const oz = yield* Control.account("Oz");
      yield* control.sql`
        INSERT INTO sessions (
          id, account_id, desired_state, observed_state, created_at, observed_at
        )
        VALUES ('lost', ${oz.account.id}, 'running', 'gone', now(), now())
      `;
      yield* oz.api.sessions.delete({ params: { id: "lost" } });
      expect((yield* Effect.flip(oz.api.sessions.get({ params: { id: "lost" } })))._tag).toBe(
        "SessionNotFound",
      );
    }),
  );
});

suite(Stores.layer())("a session deleted by itself", (it) => {
  it.effect("is deleted only while it is still due to go, as it is deleted", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* SessionsStore;
      const day = 86_400_000;
      const at = new Date(10 * day);
      const made = new Date(day);
      yield* sql`INSERT INTO accounts (id, name, admin, created_at)
        VALUES ('00000000-0000-4000-8000-00000000000a', 'Ada', false, ${made})`;
      for (const [id, pinned] of [
        ["old", false],
        ["pinned", true],
        ["slept", false],
        ["resumed", false],
      ] as const) {
        yield* sql`
          INSERT INTO sessions (
            id, account_id, desired_state, observed_state, pinned, suspended_since, created_at,
            observed_at
          )
          VALUES (
            ${id}, '00000000-0000-4000-8000-00000000000a', 'suspended', 'suspended', ${pinned},
            ${made}, ${id === "old" ? made : at}, ${made}
          )
        `;
      }
      yield* sql`
        INSERT INTO session_shares (id, session_id, account_id, name, role, token_hash, created_at)
        VALUES (
          '00000000-0000-4000-8000-000000000001', 'old', '00000000-0000-4000-8000-00000000000a',
          'link', 'watch', 'hash', ${made}
        )
      `;
      const aged = { createdBefore: new Date(5 * day), suspendedBefore: null };
      const slept = { createdBefore: null, suspendedBefore: new Date(5 * day) };

      // Pinned, or resumed, since it was read: it stays.
      expect(Option.isNone(yield* store.expire("pinned", aged, at))).toBe(true);
      expect(Option.isNone(yield* store.expire("pinned", slept, at))).toBe(true);
      yield* store.desire("resumed", "running");
      expect(Option.isNone(yield* store.expire("resumed", slept, at))).toBe(true);
      // Not due for what it is asked to go for.
      expect(Option.isNone(yield* store.expire("slept", aged, at))).toBe(true);
      expect(
        Option.isNone(
          yield* store.expire("old", { createdBefore: null, suspendedBefore: null }, at),
        ),
      ).toBe(true);

      expect(Option.isSome(yield* store.expire("slept", slept, at))).toBe(true);
      expect(Option.isSome(yield* store.expire("old", aged, at))).toBe(true);
      expect(Option.isNone(yield* store.find("old"))).toBe(true);
      expect(
        yield* sql`SELECT deleted_at IS NULL AS live FROM session_shares WHERE session_id = 'old'`,
      ).toEqual([{ live: false }]);
      // Once more, and nothing is deleted again.
      expect(Option.isNone(yield* store.expire("old", aged, at))).toBe(true);

      // One its node did not delete comes back, with its links.
      yield* store.restore("old", at);
      expect(Option.isSome(yield* store.find("old"))).toBe(true);
      expect(
        yield* sql`SELECT deleted_at IS NULL AS live FROM session_shares WHERE session_id = 'old'`,
      ).toEqual([{ live: true }]);
      expect(Option.isSome(yield* store.find("pinned"))).toBe(true);
      expect(Option.isSome(yield* store.find("resumed"))).toBe(true);
    }),
  );
});

suite(Stores.layer())("a quota", (it) => {
  it.effect("is counted alone with what is written for it, two asking at once", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* SessionsStore;
      const ada = "00000000-0000-4000-8000-00000000000b";
      yield* sql`INSERT INTO accounts (id, name, admin, created_at)
        VALUES (${ada}, 'Ada', false, now())`;
      const scope = { workspaceId: null, accountId: ada };
      const made = (id: string) =>
        store.alone(
          scope,
          Effect.gen(function* () {
            if ((yield* store.count({ ...scope, running: false })) >= 1) {
              return false;
            }
            // Long enough for the other to count, were it not kept waiting.
            yield* sql`SELECT pg_sleep(0.3)`;
            yield* sql`
              INSERT INTO sessions (
                id, account_id, desired_state, observed_state, created_at, observed_at
              )
              VALUES (${id}, ${ada}, 'suspended', 'suspended', now(), now())
            `;
            return true;
          }).pipe(Effect.orDie),
        );
      const both = yield* Effect.all([made("first"), made("second")], { concurrency: 2 });
      expect(both.filter(Boolean)).toHaveLength(1);
      expect(yield* store.count({ ...scope, running: false })).toBe(1);
    }),
  );

  it.effect(
    "of running sessions counts one asleep, and passes by one its node lost or that failed",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* SessionsStore;
        const bea = "00000000-0000-4000-8000-00000000000c";
        yield* sql`INSERT INTO accounts (id, name, admin, created_at)
          VALUES (${bea}, 'Bea', false, now())`;
        for (const [id, observed, asleep] of [
          ["awake", "running", false],
          // Whoever reaches it has it run again, and nothing refuses them.
          ["asleep", "suspended", true],
          ["lost", "gone", false],
          ["failed", "failed", false],
        ] as const) {
          yield* sql`
            INSERT INTO sessions (
              id, account_id, desired_state, observed_state, asleep, created_at, observed_at
            )
            VALUES (${id}, ${bea}, 'running', ${observed}, ${asleep}, now(), now())
          `;
        }
        const running = { workspaceId: null, accountId: bea, running: true };
        expect(yield* store.count(running)).toBe(2);
        // Started again, it counts again.
        yield* sql`UPDATE sessions SET observed_state = 'starting' WHERE id = 'failed'`;
        expect(yield* store.count(running)).toBe(3);
      }),
  );
});
