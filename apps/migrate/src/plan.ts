import type { Scope, TokenResources } from "@aperture-browser/control-api";
import { type V1Data, WITHOUT_A_HOME, type WithoutAHome } from "./v1/schemas.ts";

/** What the operator said of what v1 has that v2 has no place for as it is. */
export interface Choices {
  /**
   * v1 keeps a token as a digest v2 cannot check a token against, so none is carried
   * over: each is made anew, or left behind.
   */
  readonly tokens: "reissue" | "drop" | undefined;
  /** This program moves no sessions: they are left behind once that is said. */
  readonly sessions: "drop" | undefined;
}

/** What of v2 a plan is made against. */
export interface Known {
  /** What was moved before: `kind:v1 id` to the id it has in v2. */
  readonly moved: ReadonlyMap<string, string>;
  /** The accounts of people v2 has, by the address each signs in with, in lower case. */
  readonly people: ReadonlyMap<string, string>;
  /** The node that takes the snapshots, where one is named and v2 knows it. */
  readonly node: { readonly name: string; readonly known: boolean } | undefined;
  /** Whether a file was named for the secrets of the tokens that are made anew. */
  readonly secretsFile: boolean;
}

/** What a moved thing is known by in the record: its kind and what v1 called it. */
export type Kind = Step["kind"];
export const key = (kind: Kind, v1Id: string) => `${kind}:${v1Id}`;

/** The one account that takes the tokens of v1's system administrators. */
export const ADMIN_SERVICE = "tokens";

export type Step =
  | {
      readonly kind: "user";
      readonly v1Id: string;
      readonly name: string;
      readonly email: string;
      readonly admin: boolean;
      readonly disabledAt: Date | null;
      /** The account v2 has for that address already, which this person is then. */
      readonly joins: string | null;
    }
  | {
      readonly kind: "tenant-service" | "admin-service";
      readonly v1Id: string;
      readonly name: string;
      readonly admin: boolean;
    }
  | {
      readonly kind: "tenant";
      readonly v1Id: string;
      readonly name: string;
      readonly createdAt: Date;
    }
  | {
      readonly kind: "member";
      readonly v1Id: string;
      /** The tenant that is the workspace. */
      readonly tenant: string;
      /** What is let in, as the record knows it. */
      readonly account: string;
      readonly label: string;
      readonly role: "member" | "admin";
    }
  | {
      readonly kind: "snapshot";
      readonly v1Id: string;
      readonly name: string;
      readonly description: string | null;
      readonly tags: Readonly<Record<string, string>>;
      /** Whose it is, as the record knows them. */
      readonly account: string;
      /** The tenant that is the workspace it is of; none for one that is its account's own. */
      readonly tenant: string | null;
      readonly sessionId: string | null;
      readonly createdAt: Date;
      readonly profile: string;
    }
  | {
      readonly kind: "token";
      readonly v1Id: string;
      readonly name: string;
      /** Whose it is, as the record knows them. */
      readonly account: string;
      readonly scopes: ReadonlyArray<Scope>;
      /** The v1 snapshots it is held to; all its account reaches, without. */
      readonly snapshots: ReadonlyArray<string> | null;
      readonly expiresAt: Date | null;
    };

/** Something of v1, as a line of the plan names it. */
export interface Named {
  readonly what: string;
  readonly label: string;
  readonly reason: string;
}

export interface Plan {
  /** What `apply` does, in the order it does it. */
  readonly steps: ReadonlyArray<Step>;
  /** How much was moved before and is left as it is. */
  readonly moved: number;
  readonly skipped: ReadonlyArray<Named>;
  /** What cannot be moved as things are. With any of these, nothing is moved. */
  readonly conflicts: ReadonlyArray<Named>;
}

/** Every scope, in the order a token's are told. */
const SCOPES_ORDER: ReadonlyArray<Scope> = [
  "sessions:read",
  "sessions:write",
  "snapshots:read",
  "snapshots:write",
  "workspaces:write",
  "tokens:write",
  "events:read",
  "admin",
];

/** All a token may be held to: writing something includes reading it. */
const EVERYTHING: ReadonlyArray<Scope> = [
  "sessions:write",
  "snapshots:write",
  "workspaces:write",
  "tokens:write",
  "events:read",
  "admin",
];

/** What a scope of v1 is in v2; nothing for one v2 has no word for. */
const SCOPES: Readonly<Record<string, ReadonlyArray<Scope>>> = {
  "system:admin": EVERYTHING,
  "tenants:write": ["admin"],
  "tenant:write": ["workspaces:write", "tokens:write"],
  "sessions:read": ["sessions:read"],
  "sessions:write": ["sessions:write"],
  "snapshots:read": ["snapshots:read"],
  "snapshots:write": ["snapshots:write"],
};

/** The scopes of v1 as v2 has them, and those it has no word for. */
export const scopesOf = (scopes: ReadonlyArray<string>) => {
  const known = new Set<Scope>();
  const unknown: string[] = [];
  for (const scope of scopes) {
    const mapped = SCOPES[scope];
    if (mapped === undefined) {
      unknown.push(scope);
    } else {
      for (const one of mapped) {
        known.add(one);
      }
    }
  }
  // Writing includes reading in v2, so the weaker of a pair says nothing.
  for (const area of ["sessions", "snapshots"] as const) {
    if (known.has(`${area}:write`)) {
      known.delete(`${area}:read`);
    }
  }
  return { scopes: SCOPES_ORDER.filter((scope) => known.has(scope)), unknown };
};

/** A v1 id as v2's nodes write ids: the same UUID without its dashes. */
export const nodeId = (v1Id: string) => v1Id.replaceAll("-", "");

/** What a token's resources are once its snapshots have ids in v2. */
export const resourcesOf = (snapshots: ReadonlyArray<string>): TokenResources => ({
  workspaces: [],
  sessions: [],
  snapshots,
});

/**
 * What moving v1 into v2 comes to: what is made, what is left where it is and why, and
 * what stands in the way.
 */
export const plan = (v1: V1Data, known: Known, choices: Choices, now: Date): Plan => {
  const steps: Step[] = [];
  const skipped: Named[] = [];
  const conflicts: Named[] = [];
  let moved = 0;

  /** Takes a step unless what it makes was made before. */
  const take = (step: Step) => {
    if (known.moved.has(key(step.kind, step.v1Id))) {
      moved += 1;
    } else {
      steps.push(step);
    }
  };

  const users = new Map(v1.users.map((user) => [user.id, user]));
  const tenants = v1.tenants.filter((tenant) => {
    if (tenant.deletedAt !== null) {
      skipped.push({ what: "tenant", label: tenant.displayName, reason: "it was deleted in v1" });
    }
    return tenant.deletedAt === null;
  });
  const shared = tenants.filter((tenant) => tenant.ownerUserId === null);
  const live = new Map(tenants.map((tenant) => [tenant.id, tenant]));

  const snapshots = v1.snapshots.filter((snapshot) => {
    if (snapshot.deletedAt !== null) {
      skipped.push({ what: "snapshot", label: snapshot.name, reason: "it was deleted in v1" });
      return false;
    }
    if (!live.has(snapshot.tenantId)) {
      skipped.push({ what: "snapshot", label: snapshot.name, reason: "its tenant was deleted" });
      return false;
    }
    return true;
  });
  const tokens = v1.tokens.filter((token) => {
    const dead =
      token.revokedAt !== null
        ? "it was revoked"
        : token.expiresAt !== null && token.expiresAt.getTime() <= now.getTime()
          ? "it ran out"
          : token.tenantId !== null && !live.has(token.tenantId)
            ? "its tenant was deleted"
            : undefined;
    if (dead !== undefined) {
      skipped.push({ what: "token", label: token.name, reason: dead });
    }
    return dead === undefined;
  });
  if (choices.tokens === undefined) {
    for (const token of tokens) {
      conflicts.push({
        what: "token",
        label: token.name,
        reason:
          "v1 keeps it as a bcrypt digest, which v2 checks no token against: say --tokens reissue for a new one in its place, or --tokens drop",
      });
    }
  }
  const reissued = choices.tokens === "reissue" ? tokens : [];
  if (!known.secretsFile && reissued.some((token) => !known.moved.has(key("token", token.id)))) {
    conflicts.push({
      what: "tokens",
      label: "--tokens reissue",
      reason: "the secrets of the new tokens have nowhere to go: say --secrets-file",
    });
  }
  if (choices.tokens === "drop") {
    for (const token of tokens) {
      skipped.push({ what: "token", label: token.name, reason: "--tokens drop" });
    }
  }

  for (const user of v1.users) {
    if (user.email === null) {
      const owns = tenants.some((tenant) => tenant.ownerUserId === user.id);
      (owns ? conflicts : skipped).push({
        what: "user",
        label: user.displayName,
        reason: owns
          ? "they have no email address to sign in with, and a personal tenant that would be nobody's"
          : "they have no email address to sign in with",
      });
      continue;
    }
    take({
      kind: "user",
      v1Id: user.id,
      name: user.displayName,
      email: user.email,
      admin: user.isSystemAdmin,
      disabledAt: user.disabledAt,
      joins: known.people.get(user.email.toLowerCase()) ?? null,
    });
  }

  // A shared tenant's snapshots and tokens were nobody's in particular: an account of the
  // workspace's own has them.
  const serviced = new Set([
    ...snapshots.map((snapshot) => snapshot.tenantId),
    ...reissued.flatMap((token) => (token.tenantId === null ? [] : [token.tenantId])),
  ]);
  for (const tenant of shared) {
    take({
      kind: "tenant",
      v1Id: tenant.id,
      name: tenant.displayName,
      createdAt: tenant.createdAt,
    });
    if (serviced.has(tenant.id)) {
      take({
        kind: "tenant-service",
        v1Id: tenant.id,
        name: `${tenant.displayName} (from v1)`,
        admin: false,
      });
      take({
        kind: "member",
        v1Id: `${tenant.id}:service`,
        tenant: tenant.id,
        account: key("tenant-service", tenant.id),
        label: `${tenant.displayName} (from v1) in ${tenant.displayName}`,
        role: "admin",
      });
    }
  }
  if (reissued.some((token) => token.tenantId === null)) {
    take({
      kind: "admin-service",
      v1Id: ADMIN_SERVICE,
      name: "Admin tokens (from v1)",
      admin: true,
    });
  }

  for (const membership of v1.memberships) {
    const tenant = live.get(membership.tenantId);
    const user = users.get(membership.userId);
    // A personal tenant is its owner's own account in v2, which nobody is a member of.
    if (tenant === undefined || tenant.ownerUserId !== null || user === undefined) {
      continue;
    }
    if (user.email === null) {
      continue;
    }
    take({
      kind: "member",
      v1Id: `${tenant.id}:${user.id}`,
      tenant: tenant.id,
      account: key("user", user.id),
      label: `${user.displayName} in ${tenant.displayName}`,
      role: membership.scopes.includes("tenant:write") ? "admin" : "member",
    });
  }

  /** Whose what a tenant had is, and the workspace it is of. */
  const owner = (tenantId: string) => {
    const tenant = live.get(tenantId);
    return tenant === undefined || tenant.ownerUserId === null
      ? { account: key("tenant-service", tenantId), tenant: tenantId }
      : { account: key("user", tenant.ownerUserId), tenant: null };
  };

  const pending = snapshots.filter((snapshot) => !known.moved.has(key("snapshot", snapshot.id)));
  if (pending.length > 0 && known.node?.known !== true) {
    conflicts.push({
      what: "node",
      label: known.node?.name ?? "none",
      reason:
        known.node === undefined
          ? "there are snapshots to move and no node to take them: say --node and --node-store"
          : "the control plane knows no node of that name: start its executor first, so that it registers",
    });
  }
  for (const snapshot of snapshots) {
    if (snapshot.profile === null && !known.moved.has(key("snapshot", snapshot.id))) {
      conflicts.push({
        what: "snapshot",
        label: snapshot.name,
        reason: "its profile is not below v1's cold root: is --v1-cold-root the right directory?",
      });
      continue;
    }
    take({
      kind: "snapshot",
      v1Id: snapshot.id,
      name: snapshot.name,
      description: snapshot.description,
      tags: Object.fromEntries(
        v1.snapshotTags.filter((tag) => tag.of === snapshot.id).map((tag) => [tag.key, tag.value]),
      ),
      ...owner(snapshot.tenantId),
      sessionId: snapshot.promotedFromSessionId,
      createdAt: snapshot.createdAt,
      profile: snapshot.profile ?? "",
    });
  }

  const kept = new Set(snapshots.map((snapshot) => snapshot.id));
  for (const token of reissued) {
    const { scopes, unknown } = scopesOf(token.scopes);
    if (unknown.length > 0) {
      conflicts.push({
        what: "token",
        label: token.name,
        reason: `v2 has no scope for ${unknown.join(", ")}`,
      });
      continue;
    }
    const grants = v1.grants.filter((grant) => grant.tokenId === token.id);
    const left = grants.filter(
      (grant) => grant.resourceType === "session" || !kept.has(grant.resourceId),
    );
    if (left.length > 0) {
      skipped.push({
        what: "token",
        label: token.name,
        reason: `${left.length} of the sessions and snapshots it was held to are not moved, and it reaches the rest alone`,
      });
    }
    take({
      kind: "token",
      v1Id: token.id,
      name: token.name,
      account:
        token.tenantId === null
          ? key("admin-service", ADMIN_SERVICE)
          : owner(token.tenantId).account,
      scopes,
      snapshots:
        token.resourceMode === "all"
          ? null
          : grants
              .filter((grant) => grant.resourceType === "snapshot" && kept.has(grant.resourceId))
              .map((grant) => grant.resourceId),
      expiresAt: token.expiresAt,
    });
  }

  const keptSessions = v1.sessions.filter(
    (session) => session.expiredAt === null && session.status !== "expired",
  );
  for (const session of keptSessions) {
    (choices.sessions === "drop" ? skipped : conflicts).push({
      what: "session",
      label: session.label ?? session.id,
      reason:
        choices.sessions === "drop"
          ? "--sessions drop"
          : "this program moves no sessions, with their files and recordings: promote it to a snapshot in v1 first, or say --sessions drop",
    });
  }

  for (const [table, reason] of Object.entries(WITHOUT_A_HOME)) {
    const count = v1.withoutAHome[table as WithoutAHome];
    if (count > 0) {
      skipped.push({ what: table, label: `${count} rows`, reason });
    }
  }

  return { steps, moved, skipped, conflicts };
};
