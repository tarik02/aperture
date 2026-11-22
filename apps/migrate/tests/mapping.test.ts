import { describe, expect, it } from "@effect/vitest";
import { key, type Known, nodeId, plan, scopesOf } from "../src/plan.ts";
import type { V1Data } from "../src/v1/schemas.ts";
import { profileOf } from "../src/v1/source-sqlite.ts";

const AT = new Date("2026-01-01T00:00:00Z");
const NOW = new Date("2026-06-01T00:00:00Z");

const NOTHING: V1Data = {
  tenants: [],
  users: [],
  memberships: [],
  tokens: [],
  grants: [],
  snapshots: [],
  snapshotTags: [],
  sessions: [],
  withoutAHome: {
    user_passwords: 0,
    totp_credentials: 0,
    recovery_codes: 0,
    passkeys: 0,
    oidc_identities: 0,
    user_invitations: 0,
    web_sessions: 0,
    oauth_clients: 0,
    oauth_grants: 0,
    oauth_tokens: 0,
    session_tokens: 0,
    session_collaboration_capabilities: 0,
    events: 0,
    audit_events: 0,
  },
};

const FRESH: Known = { moved: new Map(), people: new Map(), node: undefined, secretsFile: true };
const SAID = { tokens: "reissue", sessions: "drop" } as const;

const user = (id: string, email: string | null = `${id}@example.com`) => ({
  id,
  email,
  displayName: id,
  isSystemAdmin: false,
  createdAt: AT,
  disabledAt: null,
});
const tenant = (id: string, ownerUserId: string | null = null) => ({
  id,
  displayName: id,
  createdAt: AT,
  deletedAt: null,
  ownerUserId,
});
const token = (id: string, tenantId: string | null, scopes: ReadonlyArray<string>) => ({
  id,
  authorityType: tenantId === null ? ("system_admin" as const) : ("tenant" as const),
  tenantId,
  name: id,
  scopes,
  createdAt: AT,
  createdByType: "system" as const,
  createdById: null,
  resourceMode: "all" as const,
  expiresAt: null,
  revokedAt: null,
});
const snapshot = (id: string, tenantId: string) => ({
  id,
  tenantId,
  name: id,
  description: null,
  promotedFromSessionId: null,
  createdAt: AT,
  deletedAt: null,
  profile: `/v1/${id}/profile`,
});

const kinds = (steps: ReturnType<typeof plan>["steps"]) => steps.map((step) => step.kind);

describe("what v1 has, as v2 has it", () => {
  it("a scope of v1 is the scopes of v2 that let do the same", () => {
    expect(scopesOf(["sessions:read", "sessions:write", "snapshots:read"])).toEqual({
      scopes: ["sessions:write", "snapshots:read"],
      unknown: [],
    });
    expect(scopesOf(["tenant:write"]).scopes).toEqual(["workspaces:write", "tokens:write"]);
    expect(scopesOf(["system:admin"]).scopes).toEqual([
      "sessions:write",
      "snapshots:write",
      "workspaces:write",
      "tokens:write",
      "events:read",
      "admin",
    ]);
    expect(scopesOf(["sessions:read", "recordings:read"]).unknown).toEqual(["recordings:read"]);
  });

  it("an id of v1 is a node's without its dashes", () => {
    expect(nodeId("01a2042d-6f66-71ff-a5a0-b26573efc3e7")).toBe("01a2042d6f6671ffa5a0b26573efc3e7");
  });

  it("a snapshot's profile is below the cold root by its id's first bytes", () => {
    expect(profileOf("/cold", "01a2042d-6f66-71ff-a5a0-b26573efc3e7")).toBe(
      "/cold/snapshots/01/a2/01a2042d-6f66-71ff-a5a0-b26573efc3e7/profile",
    );
  });

  it("a shared tenant is a workspace, and who was in it is in it", () => {
    const planned = plan(
      {
        ...NOTHING,
        tenants: [tenant("team")],
        users: [user("alice"), user("bob")],
        memberships: [
          { tenantId: "team", userId: "alice", scopes: ["tenant:write"], createdAt: AT },
          { tenantId: "team", userId: "bob", scopes: ["sessions:read"], createdAt: AT },
        ],
      },
      FRESH,
      SAID,
      NOW,
    );
    expect(planned.conflicts).toEqual([]);
    expect(kinds(planned.steps)).toEqual(["user", "user", "tenant", "member", "member"]);
    expect(planned.steps.filter((step) => step.kind === "member")).toMatchObject([
      { tenant: "team", account: "user:alice", role: "admin" },
      { tenant: "team", account: "user:bob", role: "member" },
    ]);
  });

  it("a personal tenant is its owner's own account: no workspace, and its snapshots theirs", () => {
    const planned = plan(
      {
        ...NOTHING,
        tenants: [tenant("alices", "alice")],
        users: [user("alice")],
        memberships: [
          { tenantId: "alices", userId: "alice", scopes: ["tenant:write"], createdAt: AT },
        ],
        snapshots: [snapshot("base", "alices")],
      },
      { ...FRESH, node: { name: "node-a", known: true } },
      SAID,
      NOW,
    );
    expect(planned.conflicts).toEqual([]);
    expect(kinds(planned.steps)).toEqual(["user", "snapshot"]);
    expect(planned.steps[1]).toMatchObject({ account: "user:alice", tenant: null });
  });

  it("what a shared tenant had is an account's of the workspace's own", () => {
    const planned = plan(
      {
        ...NOTHING,
        tenants: [tenant("team")],
        tokens: [token("ci", "team", ["sessions:write"])],
        snapshots: [snapshot("base", "team")],
      },
      { ...FRESH, node: { name: "node-a", known: true } },
      SAID,
      NOW,
    );
    expect(kinds(planned.steps)).toEqual([
      "tenant",
      "tenant-service",
      "member",
      "snapshot",
      "token",
    ]);
    expect(planned.steps[2]).toMatchObject({ account: "tenant-service:team", role: "admin" });
    expect(planned.steps[3]).toMatchObject({ account: "tenant-service:team", tenant: "team" });
    expect(planned.steps[4]).toMatchObject({ account: "tenant-service:team", snapshots: null });
  });

  it("a token is in the way until it is said what becomes of it", () => {
    const v1 = {
      ...NOTHING,
      tenants: [tenant("team")],
      tokens: [token("ci", "team", ["sessions:read"])],
    };
    const unsaid = plan(v1, FRESH, { tokens: undefined, sessions: undefined }, NOW);
    expect(unsaid.conflicts.map((conflict) => conflict.what)).toEqual(["token"]);
    expect(kinds(unsaid.steps)).toEqual(["tenant"]);

    const dropped = plan(v1, FRESH, { tokens: "drop", sessions: undefined }, NOW);
    expect(dropped.conflicts).toEqual([]);
    expect(dropped.skipped).toMatchObject([{ what: "token", reason: "--tokens drop" }]);

    const nowhere = plan(v1, { ...FRESH, secretsFile: false }, SAID, NOW);
    expect(nowhere.conflicts.map((conflict) => conflict.what)).toEqual(["tokens"]);
  });

  it("a token of a system administrator is an admin service account's", () => {
    const planned = plan(
      { ...NOTHING, tokens: [token("root", null, ["system:admin"])] },
      FRESH,
      SAID,
      NOW,
    );
    expect(planned.steps).toMatchObject([
      { kind: "admin-service", admin: true },
      { kind: "token", account: "admin-service:tokens" },
    ]);
  });

  it("a token that was revoked or ran out is left, and one of a scope v2 lacks is in the way", () => {
    const planned = plan(
      {
        ...NOTHING,
        tenants: [tenant("team")],
        tokens: [
          { ...token("revoked", "team", ["sessions:read"]), revokedAt: AT },
          { ...token("over", "team", ["sessions:read"]), expiresAt: AT },
          token("odd", "team", ["recordings:read"]),
        ],
      },
      FRESH,
      SAID,
      NOW,
    );
    expect(planned.skipped.map((left) => left.label)).toEqual(["revoked", "over"]);
    expect(planned.conflicts).toMatchObject([{ what: "token", label: "odd" }]);
  });

  it("a token held to resources is held to the snapshots that are moved", () => {
    const planned = plan(
      {
        ...NOTHING,
        tenants: [tenant("team")],
        tokens: [{ ...token("held", "team", ["snapshots:read"]), resourceMode: "allowlist" }],
        grants: [
          { tokenId: "held", resourceType: "snapshot", resourceId: "base" },
          { tokenId: "held", resourceType: "session", resourceId: "a-session" },
        ],
        snapshots: [snapshot("base", "team")],
      },
      { ...FRESH, node: { name: "node-a", known: true } },
      SAID,
      NOW,
    );
    expect(planned.steps.at(-1)).toMatchObject({ kind: "token", snapshots: ["base"] });
    expect(planned.skipped).toMatchObject([{ what: "token", label: "held" }]);
  });

  it("snapshots are in the way without a node the control plane knows, or without their profile", () => {
    const v1 = { ...NOTHING, tenants: [tenant("team")], snapshots: [snapshot("base", "team")] };
    expect(plan(v1, FRESH, SAID, NOW).conflicts).toMatchObject([{ what: "node", label: "none" }]);
    expect(
      plan(v1, { ...FRESH, node: { name: "node-a", known: false } }, SAID, NOW).conflicts,
    ).toMatchObject([{ what: "node", label: "node-a" }]);
    expect(
      plan(
        { ...v1, snapshots: [{ ...snapshot("base", "team"), profile: null }] },
        { ...FRESH, node: { name: "node-a", known: true } },
        SAID,
        NOW,
      ).conflicts,
    ).toMatchObject([{ what: "snapshot", label: "base" }]);
  });

  it("what was deleted in v1 is left there", () => {
    const planned = plan(
      {
        ...NOTHING,
        tenants: [{ ...tenant("gone"), deletedAt: AT }, tenant("team")],
        tokens: [token("of-gone", "gone", ["sessions:read"])],
        snapshots: [snapshot("of-gone", "gone"), { ...snapshot("dropped", "team"), deletedAt: AT }],
      },
      FRESH,
      SAID,
      NOW,
    );
    expect(kinds(planned.steps)).toEqual(["tenant"]);
    expect(planned.conflicts).toEqual([]);
    expect(planned.skipped.map((left) => `${left.what} ${left.label}`)).toEqual([
      "tenant gone",
      "snapshot of-gone",
      "snapshot dropped",
      "token of-gone",
    ]);
  });

  it("a session v1 still keeps is in the way until it is said to be left", () => {
    const v1 = {
      ...NOTHING,
      tenants: [tenant("team")],
      sessions: [
        {
          id: "kept",
          tenantId: "team",
          label: "kept",
          status: "suspended" as const,
          expiredAt: null,
        },
        { id: "over", tenantId: "team", label: null, status: "expired" as const, expiredAt: AT },
      ],
    };
    expect(
      plan(v1, FRESH, { tokens: undefined, sessions: undefined }, NOW).conflicts,
    ).toMatchObject([{ what: "session", label: "kept" }]);
    expect(plan(v1, FRESH, SAID, NOW).skipped).toMatchObject([{ what: "session", label: "kept" }]);
  });

  it("a person v2 has already is that person, and one with no address is nobody", () => {
    const planned = plan(
      {
        ...NOTHING,
        tenants: [tenant("hers", "nobody")],
        users: [user("alice", "Alice@Example.com"), user("nobody", null), user("bare", null)],
      },
      { ...FRESH, people: new Map([["alice@example.com", "account-of-alice"]]) },
      SAID,
      NOW,
    );
    expect(planned.steps).toMatchObject([{ kind: "user", joins: "account-of-alice" }]);
    expect(planned.conflicts).toMatchObject([{ what: "user", label: "nobody" }]);
    expect(planned.skipped).toMatchObject([{ what: "user", label: "bare" }]);
  });

  it("what was moved before is not moved again", () => {
    const v1 = {
      ...NOTHING,
      tenants: [tenant("team")],
      users: [user("alice")],
      memberships: [{ tenantId: "team", userId: "alice", scopes: ["tenant:write"], createdAt: AT }],
      tokens: [token("ci", "team", ["sessions:read"])],
      snapshots: [snapshot("base", "team")],
    };
    const known = { ...FRESH, node: { name: "node-a", known: true } };
    const first = plan(v1, known, SAID, NOW);
    const again = plan(
      v1,
      // Nothing is asked of the node or of a secrets file once all is moved.
      {
        ...FRESH,
        secretsFile: false,
        moved: new Map(first.steps.map((step) => [key(step.kind, step.v1Id), "in-v2"])),
      },
      SAID,
      NOW,
    );
    expect(again.steps).toEqual([]);
    expect(again.conflicts).toEqual([]);
    expect(again.moved).toBe(first.steps.length);

    const half = plan(
      v1,
      { ...known, moved: new Map([[key("user", "alice"), "in-v2"]]) },
      SAID,
      NOW,
    );
    expect(half.moved).toBe(1);
    expect(half.steps.length).toBe(first.steps.length - 1);
  });

  it("tables v2 has no place for are told with how much they hold", () => {
    const planned = plan(
      { ...NOTHING, withoutAHome: { ...NOTHING.withoutAHome, passkeys: 2, events: 40 } },
      FRESH,
      SAID,
      NOW,
    );
    expect(planned.skipped.map((left) => `${left.what} ${left.label}`)).toEqual([
      "passkeys 2 rows",
      "events 40 rows",
    ]);
  });
});
