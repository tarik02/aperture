import { describe, expect, it } from "@effect/vitest";
import { installId, key, type Known, nodeId, plan, scopesOf, type Step } from "../src/plan.ts";
import { routingOf } from "../src/routing.ts";
import type { V1Data } from "../src/v1/schemas.ts";
import { profileOf, sessionOf } from "../src/v1/source-sqlite.ts";

const AT = new Date("2026-01-01T00:00:00Z");
const NOW = new Date("2026-06-01T00:00:00Z");
const INSTALL = "7229a6d6d7921d3643f0dec66c5192d8";

const NOTHING: V1Data = {
  tenants: [],
  users: [],
  memberships: [],
  tokens: [],
  grants: [],
  snapshots: [],
  snapshotTags: [],
  sessions: [],
  sessionTags: [],
  install: { installId: INSTALL, createdAt: AT },
  withoutAHome: {
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

const FRESH: Known = {
  made: new Map(),
  members: new Set(),
  people: new Map(),
  node: undefined,
  secretsFile: true,
};
const ON_A_NODE: Known = { ...FRESH, node: { name: "node-a", known: true } };
const SAID = { tokens: "reissue", sessions: undefined } as const;

const user = (id: string, email: string | null = `${id}@example.com`) => ({
  id,
  email,
  displayName: id,
  isSystemAdmin: false,
  createdAt: AT,
  disabledAt: null,
  passwordHash: null as string | null,
  totpSecret: null as string | null,
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
  tokenHash: `$2a$10$digest-of-${id}`,
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
  profile: `/v1/${id}/profile` as string | null,
});
const session = (id: string, tenantId: string) => ({
  id,
  tenantId,
  baseSnapshotId: null as string | null,
  label: id as string | null,
  status: "suspended" as V1Data["sessions"][number]["status"],
  createdAt: AT,
  expiredAt: null as Date | null,
  proxyConfig: null as string | null,
  upper: `/v1/${id}/upper` as string | null,
  files: `/v1/${id}/files` as string | null,
  mounted: false,
});

const kinds = (steps: ReadonlyArray<Step>) => steps.map((step) => step.kind);

/** What v2 has once the steps were done. */
const after = (known: Known, steps: ReadonlyArray<Step>): Known => ({
  ...known,
  made: new Map(
    steps.flatMap((step) =>
      step.kind === "member"
        ? []
        : [
            [
              key(
                step.kind === "person" || step.kind === "bearer" ? "account" : step.kind,
                step.id,
              ),
              step.createdAt,
            ] as const,
          ],
    ),
  ),
  members: new Set(
    steps.flatMap((step) =>
      step.kind === "member" ? [`${step.workspaceId}:${step.accountId}`] : [],
    ),
  ),
});

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

  it("an id of v1 is a node's without its dashes, and an installation's is a UUID", () => {
    expect(nodeId("01a2042d-6f66-71ff-a5a0-b26573efc3e7")).toBe("01a2042d6f6671ffa5a0b26573efc3e7");
    // Of version 8, with the variant every UUID has: v2 takes no other for an id.
    expect(installId(INSTALL)).toBe("7229a6d6-d792-8d36-83f0-dec66c5192d8");
  });

  it("what v1 keeps is below its roots by the first bytes of its id", () => {
    const id = "01a2042d-6f66-71ff-a5a0-b26573efc3e7";
    expect(profileOf("/cold", id)).toBe(`/cold/snapshots/01/a2/${id}/profile`);
    expect(sessionOf({ database: "", coldRoot: "/cold", storeRoot: "/store" }, id)).toEqual({
      upper: `/store/sessions/01/a2/${id}/upper`,
      merged: `/store/sessions/01/a2/${id}/merged`,
      files: `/cold/sessions/01/a2/${id}/files`,
    });
  });

  it("a shared tenant is a workspace with its id, and who was in it is in it", () => {
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
    expect(planned.steps).toMatchObject([
      { kind: "person", id: "alice", createdAt: AT },
      { kind: "person", id: "bob", createdAt: AT },
      { kind: "workspace", id: "team", createdAt: AT },
      { kind: "member", workspaceId: "team", accountId: "alice", role: "admin" },
      { kind: "member", workspaceId: "team", accountId: "bob", role: "member" },
    ]);
  });

  it("what a personal tenant had is its owner's own: no workspace, and nobody a member", () => {
    const planned = plan(
      {
        ...NOTHING,
        tenants: [tenant("alices", "alice")],
        users: [user("alice")],
        memberships: [
          { tenantId: "alices", userId: "alice", scopes: ["tenant:write"], createdAt: AT },
        ],
        snapshots: [snapshot("base", "alices")],
        sessions: [session("hers", "alices")],
        tokens: [token("own", "alices", ["sessions:read"])],
      },
      ON_A_NODE,
      SAID,
      NOW,
    );
    expect(planned.conflicts).toEqual([]);
    expect(planned.steps).toMatchObject([
      { kind: "person", id: "alice" },
      { kind: "snapshot", accountId: "alice", workspaceId: null },
      { kind: "session", accountId: "alice", workspaceId: null },
      { kind: "token", accountId: "alice" },
    ]);
  });

  it("what a shared tenant had is the workspace's, and nobody's in particular", () => {
    const planned = plan(
      {
        ...NOTHING,
        tenants: [tenant("team")],
        snapshots: [snapshot("base", "team")],
        sessions: [session("shared", "team")],
      },
      ON_A_NODE,
      SAID,
      NOW,
    );
    // No account is made for them to be of.
    expect(planned.steps).toMatchObject([
      { kind: "workspace", id: "team" },
      { kind: "snapshot", accountId: null, workspaceId: "team" },
      { kind: "session", accountId: null, workspaceId: "team" },
    ]);
  });

  it("a shared tenant's tokens are a service account's, which is made for them alone", () => {
    const v1 = { ...NOTHING, tenants: [tenant("team")] };
    const reads = plan(
      { ...v1, tokens: [token("ci", "team", ["sessions:write"])] },
      FRESH,
      SAID,
      NOW,
    );
    expect(reads.steps).toMatchObject([
      { kind: "workspace", id: "team" },
      { kind: "bearer", id: "team", name: "team tokens (from v1)", admin: false, createdAt: AT },
      { kind: "member", workspaceId: "team", accountId: "team", role: "member" },
      { kind: "token", id: "ci", accountId: "team", resources: null, createdAt: AT },
    ]);
    // Who is in a workspace is for an admin of it to say.
    const manages = plan(
      { ...v1, tokens: [token("ops", "team", ["tenant:write"])] },
      FRESH,
      SAID,
      NOW,
    );
    expect(manages.steps[2]).toMatchObject({ kind: "member", role: "admin" });
    expect(kinds(plan(v1, FRESH, SAID, NOW).steps)).toEqual(["workspace"]);
    expect(
      kinds(
        plan(
          { ...v1, tokens: [token("ci", "team", ["sessions:write"])] },
          FRESH,
          { ...SAID, tokens: "drop" },
          NOW,
        ).steps,
      ),
    ).toEqual(["workspace"]);
  });

  it("a personal tenant's token is said to reach its owner's workspaces as well", () => {
    const v1 = {
      ...NOTHING,
      tenants: [tenant("alices", "alice"), tenant("team")],
      users: [user("alice")],
      tokens: [token("own", "alices", ["sessions:read"])],
    };
    expect(plan(v1, FRESH, SAID, NOW).notes).toEqual([]);
    const inATeam = plan(
      {
        ...v1,
        memberships: [
          { tenantId: "alices", userId: "alice", scopes: ["tenant:write"], createdAt: AT },
          { tenantId: "team", userId: "alice", scopes: ["sessions:read"], createdAt: AT },
        ],
      },
      FRESH,
      SAID,
      NOW,
    );
    expect(inATeam.notes).toMatchObject([{ what: "token", label: "own" }]);
    expect(inATeam.conflicts).toEqual([]);
  });

  it("a token is kept with v1's digest of it, made anew, or left behind", () => {
    const v1 = {
      ...NOTHING,
      tenants: [tenant("team")],
      tokens: [token("ci", "team", ["sessions:read"])],
    };
    // Kept, it needs no file for a secret: its holder has it.
    const kept = plan(
      v1,
      { ...FRESH, secretsFile: false },
      { tokens: "keep", sessions: undefined },
      NOW,
    );
    expect(kept.conflicts).toEqual([]);
    expect(kept.steps.at(-1)).toMatchObject({
      kind: "token",
      id: "ci",
      digest: "$2a$10$digest-of-ci",
    });
    expect(plan(v1, FRESH, SAID, NOW).steps.at(-1)).toMatchObject({ kind: "token", digest: null });

    const dropped = plan(v1, FRESH, { tokens: "drop", sessions: undefined }, NOW);
    expect(dropped.conflicts).toEqual([]);
    expect(dropped.skipped).toMatchObject([{ what: "token", reason: "--tokens drop" }]);

    const nowhere = plan(v1, { ...FRESH, secretsFile: false }, SAID, NOW);
    expect(nowhere.conflicts.map((conflict) => conflict.what)).toEqual(["tokens"]);
  });

  it("a token of a system administrator is an admin service account's, which the installation names", () => {
    const planned = plan(
      { ...NOTHING, tokens: [token("root", null, ["system:admin"])] },
      FRESH,
      SAID,
      NOW,
    );
    expect(planned.steps).toMatchObject([
      { kind: "bearer", id: installId(INSTALL), admin: true },
      { kind: "token", accountId: installId(INSTALL) },
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

  it("a token held to resources is held to the sessions and snapshots that are moved", () => {
    const planned = plan(
      {
        ...NOTHING,
        tenants: [tenant("team")],
        tokens: [{ ...token("held", "team", ["snapshots:read"]), resourceMode: "allowlist" }],
        grants: [
          { tokenId: "held", resourceType: "snapshot", resourceId: "ba-se" },
          { tokenId: "held", resourceType: "session", resourceId: "ke-pt" },
          { tokenId: "held", resourceType: "session", resourceId: "gone" },
        ],
        snapshots: [snapshot("ba-se", "team")],
        sessions: [session("ke-pt", "team"), { ...session("gone", "team"), status: "deleted" }],
      },
      ON_A_NODE,
      SAID,
      NOW,
    );
    expect(planned.steps.at(-1)).toMatchObject({
      kind: "token",
      resources: { workspaces: [], sessions: ["kept"], snapshots: ["base"] },
    });
    expect(planned.skipped).toMatchObject([
      { what: "session", label: "gone" },
      { what: "token", label: "held" },
    ]);
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
        ON_A_NODE,
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
        sessions: [
          session("in-gone", "gone"),
          { ...session("deleted", "team"), status: "deleted" },
        ],
      },
      FRESH,
      SAID,
      NOW,
    );
    expect(kinds(planned.steps)).toEqual(["workspace"]);
    expect(planned.conflicts).toEqual([]);
    expect(planned.skipped.map((left) => `${left.what} ${left.label}`)).toEqual([
      "tenant gone",
      "snapshot of-gone",
      "snapshot dropped",
      "token of-gone",
      "session in-gone",
      "session deleted",
    ]);
  });

  it("a session v1 keeps is moved suspended, on the snapshot it was created from", () => {
    const planned = plan(
      {
        ...NOTHING,
        tenants: [tenant("team")],
        snapshots: [snapshot("ba-se", "team")],
        sessions: [
          { ...session("pl-ain", "team"), files: null },
          { ...session("ba-sed", "team"), baseSnapshotId: "ba-se", status: "running" },
          { ...session("failed", "team"), status: "failed" },
          // What v1 removed, and what it never had.
          { ...session("over", "team"), status: "expired", expiredAt: AT },
          { ...session("half", "team"), status: "creating" },
          { ...session("broken", "team"), status: "failed", upper: null },
        ],
        sessionTags: [{ of: "pl-ain", key: "purpose", value: "checks" }],
      },
      ON_A_NODE,
      SAID,
      NOW,
    );
    expect(planned.conflicts).toEqual([]);
    expect(planned.steps.filter((step) => step.kind === "session")).toMatchObject([
      {
        id: "plain",
        label: "pl-ain",
        tags: { purpose: "checks" },
        snapshotId: null,
        layer: null,
        proxy: null,
        createdAt: AT,
        upper: "/v1/pl-ain/upper",
        files: null,
        wasRunning: false,
      },
      // The layer is the moved snapshot's, which has the snapshot's id.
      { id: "based", snapshotId: "base", layer: { id: "base", profile: null }, wasRunning: true },
      { id: "failed", wasRunning: false },
    ]);
    expect(planned.skipped.map((left) => `${left.what} ${left.label}`)).toEqual([
      "session half",
      "session broken",
    ]);
  });

  it("a session on a snapshot v1 deleted stands on that snapshot's profile, and names none", () => {
    const v1 = {
      ...NOTHING,
      tenants: [tenant("team")],
      snapshots: [{ ...snapshot("dropped", "team"), deletedAt: AT }],
      sessions: [{ ...session("based", "team"), baseSnapshotId: "dropped" }],
    };
    const planned = plan(v1, ON_A_NODE, SAID, NOW);
    expect(kinds(planned.steps)).toEqual(["workspace", "session"]);
    expect(planned.steps[1]).toMatchObject({
      snapshotId: null,
      layer: { id: "dropped", profile: "/v1/dropped/profile" },
    });
    const gone = plan(
      { ...v1, snapshots: [{ ...snapshot("dropped", "team"), deletedAt: AT, profile: null }] },
      ON_A_NODE,
      SAID,
      NOW,
    );
    expect(gone.conflicts).toMatchObject([{ what: "session", label: "based" }]);
  });

  it("a session is in the way whose profile is not there, or is still mounted", () => {
    const v1 = { ...NOTHING, tenants: [tenant("team")] };
    const conflicts = (given: ReturnType<typeof session>, known = ON_A_NODE) =>
      plan({ ...v1, sessions: [given] }, known, SAID, NOW).conflicts.map(
        (conflict) => `${conflict.what} ${conflict.label}`,
      );
    expect(conflicts({ ...session("bare", "team"), upper: null })).toEqual(["session bare"]);
    expect(conflicts({ ...session("busy", "team"), status: "running", mounted: true })).toEqual([
      "session busy",
    ]);
    expect(conflicts({ ...session("odd", "team"), proxyConfig: "not json" })).toEqual([
      "session odd",
    ]);
    expect(conflicts(session("fine", "team"), FRESH)).toEqual(["node none"]);
    // Left behind, nothing of them is in the way.
    const dropped = plan(
      { ...v1, sessions: [{ ...session("busy", "team"), mounted: true }] },
      FRESH,
      { ...SAID, sessions: "drop" },
      NOW,
    );
    expect(dropped.conflicts).toEqual([]);
    expect(dropped.skipped).toMatchObject([{ what: "session", reason: "--sessions drop" }]);
  });

  it("a session's routing is v2's as it was written, a match that names an IPv6 address too", () => {
    expect(routingOf(null)).toEqual({ proxy: null });
    expect(routingOf("{}")).toEqual({ proxy: null });
    expect(routingOf("[]")).toBeUndefined();
    const kept = {
      upstreams: {
        corp: { url: "socks5://user:secret@proxy.example:1080" },
        operator: { url: "wss+yamux+socks5://tunnel.example/x", auth: "secret" },
      },
      rules: [
        { match: "*.corp.test", via: "corp" },
        { match: "app.test:8443", via: "operator" },
        { match: "localhost:3000", via: "local" },
        { match: "*", via: "http://proxy.example:8080" },
      ],
    };
    expect(routingOf(JSON.stringify(kept))).toEqual({ proxy: kept });
    const byAddress = {
      rules: [
        { match: "[2001:db8::1]:443", via: "refuse" },
        { match: "2001:db8::1", via: "refuse" },
        { match: "blocked.test", via: "refuse" },
      ],
    };
    expect(routingOf(JSON.stringify(byAddress))).toEqual({ proxy: byAddress });

    const planned = plan(
      {
        ...NOTHING,
        tenants: [tenant("team")],
        sessions: [
          {
            ...session("routed", "team"),
            proxyConfig: JSON.stringify({ rules: [{ match: "[::1]:80", via: "refuse" }] }),
          },
        ],
      },
      ON_A_NODE,
      SAID,
      NOW,
    );
    expect(planned.steps[1]).toMatchObject({
      kind: "session",
      proxy: { rules: [{ match: "[::1]:80", via: "refuse" }] },
    });
    expect(planned.skipped).toEqual([]);
  });

  it("a person keeps the password and the second factor they had in v1", () => {
    const planned = plan(
      {
        ...NOTHING,
        users: [
          {
            ...user("alice"),
            passwordHash: "$argon2id$v=19$m=65536,t=3,p=2$c2FsdA$aGFzaA",
            totpSecret: "JBSWY3DPEHPK3PXP",
          },
          user("bob"),
        ],
      },
      FRESH,
      SAID,
      NOW,
    );
    expect(planned.steps).toMatchObject([
      {
        kind: "person",
        id: "alice",
        password: "$argon2id$v=19$m=65536,t=3,p=2$c2FsdA$aGFzaA",
        secondFactor: "JBSWY3DPEHPK3PXP",
      },
      { kind: "person", id: "bob", password: null, secondFactor: null },
    ]);
    // One v2 has an account for already signs in as they do there.
    const there = plan(
      { ...NOTHING, users: [{ ...user("alice"), passwordHash: "$argon2id$…" }] },
      { ...FRESH, people: new Map([["alice@example.com", "account-of-alice"]]) },
      SAID,
      NOW,
    );
    expect(there.steps).toEqual([]);
    expect(there.notes[0]?.reason).toContain("not their password or second factor of v1");
  });

  it("a person v2 has already is that person, and one with no address is nobody", () => {
    const planned = plan(
      {
        ...NOTHING,
        tenants: [tenant("hers", "nobody"), tenant("alices", "alice")],
        users: [user("alice", "Alice@Example.com"), user("nobody", null), user("bare", null)],
        snapshots: [snapshot("base", "alices"), snapshot("nobodys", "hers")],
      },
      { ...ON_A_NODE, people: new Map([["alice@example.com", "account-of-alice"]]) },
      SAID,
      NOW,
    );
    // What was hers is the account's v2 has for her address.
    expect(planned.steps).toMatchObject([{ kind: "snapshot", accountId: "account-of-alice" }]);
    expect(planned.conflicts).toMatchObject([{ what: "user", label: "nobody" }]);
    expect(planned.notes).toMatchObject([{ what: "user", label: "alice" }]);
    expect(planned.skipped).toMatchObject([{ what: "user", label: "bare" }]);
  });

  it("what v2 has under an id of v1's was moved before, unless it was made at another moment", () => {
    const v1 = {
      ...NOTHING,
      tenants: [tenant("team")],
      users: [user("alice")],
      memberships: [{ tenantId: "team", userId: "alice", scopes: ["tenant:write"], createdAt: AT }],
      tokens: [token("ci", "team", ["sessions:read"])],
      snapshots: [snapshot("base", "team")],
      sessions: [session("kept", "team")],
    };
    const first = plan(v1, ON_A_NODE, SAID, NOW);
    expect(kinds(first.steps)).toEqual([
      "person",
      "workspace",
      "bearer",
      "member",
      "member",
      "snapshot",
      "session",
      "token",
    ]);
    // Nothing is asked of a node or of a secrets file once all is moved.
    const again = plan(v1, after({ ...FRESH, secretsFile: false }, first.steps), SAID, NOW);
    expect(again.steps).toEqual([]);
    expect(again.conflicts).toEqual([]);
    expect(again.moved).toBe(first.steps.length);

    const half = plan(v1, after(ON_A_NODE, first.steps.slice(0, 1)), SAID, NOW);
    expect(half.moved).toBe(1);
    expect(half.steps).toEqual(first.steps.slice(1));

    const other = plan(
      v1,
      {
        ...ON_A_NODE,
        made: new Map([
          [key("account", "alice"), NOW],
          [key("session", "kept"), NOW],
        ]),
      },
      SAID,
      NOW,
    );
    expect(other.conflicts.map((conflict) => `${conflict.what} ${conflict.label}`)).toEqual([
      "account alice",
      "session kept",
    ]);
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
