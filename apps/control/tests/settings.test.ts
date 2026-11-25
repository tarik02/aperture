import { suite } from "@aperture-browser/e2e/src/suite.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import { awake, boundsOf, check, resolve } from "../src/policy/cascade.ts";
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
    const stays = { value: true, source: "workspace", locked: false, clamped: false } as const;
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
