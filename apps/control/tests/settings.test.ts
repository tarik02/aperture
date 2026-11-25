import { suite } from "@aperture-browser/e2e/src/suite.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { boundsOf, check, resolve } from "../src/policy/cascade.ts";
import * as Control from "./src/control.ts";

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
    });
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
    });
    const none = [{ level: "instance", entry: { value: "anyone", allowed: ["nobody"] } }] as const;
    expect(resolve("pinning", none, { value: "anyone", source: "default" })).toEqual({
      value: "nobody",
      source: "instance",
      locked: true,
      clamped: true,
    });
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
      ["sessionsPerUser", "account", { value: 3 }],
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
        expect(read.settings.find((one) => one.key === "maxSessionAge")).toMatchObject({
          here: { max: 86_400 },
          changeable: false,
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

        // An account says its own, below the workspace it has things in.
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
        expect(own.effective).toMatchObject({ value: 5400, source: "account" });
        // Of what is its own, the workspace's bounds do not hold.
        expect(
          (yield* bea.api.settings.account({ query: {} })).settings.find(
            (one) => one.key === "maxSessionAge",
          )?.effective,
        ).toMatchObject({ value: 5400, source: "account" });

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
        const cleared = yield* ada.api.settings.clearWorkspace({ params: at });
        expect(cleared.here).toBeNull();
      }),
  );
});
