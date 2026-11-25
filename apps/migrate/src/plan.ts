import type { ProxyConfig, Scope, TokenResources } from "@aperture-browser/control-api";
import { routingOf } from "./routing.ts";
import { type V1Data, WITHOUT_A_HOME, type WithoutAHome } from "./v1/schemas.ts";

/** What the operator said of what v1 has that v2 has no place for as it is. */
export interface Choices {
  /**
   * v1 keeps a token as a bcrypt digest, which v2 finds no token by: each is kept with it
   * and checked against it once, made anew, or left behind.
   */
  readonly tokens: "keep" | "reissue" | "drop";
  /** Sessions are moved unless they are said to be left behind. */
  readonly sessions: "drop" | undefined;
}

/** What is told apart by its id in v2, each kind among its own. */
export type Made = "account" | "workspace" | "snapshot" | "session" | "token";
export const key = (made: Made, id: string) => `${made}:${id}`;

/** What of v2 a plan is made against. */
export interface Known {
  /** What v2 has, by `kind:id`, with when each was made. */
  readonly made: ReadonlyMap<string, Date>;
  /** Who is in which workspace, as `workspace:account`. */
  readonly members: ReadonlySet<string>;
  /** The accounts of people v2 has, by the address each signs in with, in lower case. */
  readonly people: ReadonlyMap<string, string>;
  /** The node that takes the snapshots and sessions, where one is named and v2 knows it. */
  readonly node: { readonly name: string; readonly known: boolean } | undefined;
  /** Whether a file was named for the secrets of the tokens that are made anew. */
  readonly secretsFile: boolean;
}

export type Step =
  | {
      readonly kind: "person";
      readonly id: string;
      readonly name: string;
      readonly email: string;
      readonly admin: boolean;
      readonly disabledAt: Date | null;
      readonly createdAt: Date;
      /** Their password as v1 kept it. */
      readonly password: string | null;
      /** Their authenticator's secret as v1 kept it. */
      readonly secondFactor: string | null;
    }
  | {
      /** A service account that is the bearer of the tokens moved, and nothing else. */
      readonly kind: "bearer";
      readonly id: string;
      readonly name: string;
      readonly admin: boolean;
      readonly createdAt: Date;
    }
  | {
      readonly kind: "workspace";
      readonly id: string;
      readonly name: string;
      readonly createdAt: Date;
    }
  | {
      readonly kind: "member";
      readonly workspaceId: string;
      readonly accountId: string;
      readonly label: string;
      readonly role: "member" | "admin";
    }
  | {
      readonly kind: "snapshot";
      readonly id: string;
      readonly name: string;
      readonly description: string | null;
      readonly tags: Readonly<Record<string, string>>;
      /** Whose own it is; none for a workspace's, which v1 says nobody made. */
      readonly accountId: string | null;
      readonly workspaceId: string | null;
      /** The session it was taken of. */
      readonly sessionId: string | null;
      readonly createdAt: Date;
      readonly profile: string;
    }
  | {
      readonly kind: "session";
      readonly id: string;
      readonly label: string | null;
      readonly tags: Readonly<Record<string, string>>;
      /** Whose own it is; none for a workspace's, which v1 says nobody made. */
      readonly accountId: string | null;
      readonly workspaceId: string | null;
      /** The snapshot it was created from, where that is moved as well. */
      readonly snapshotId: string | null;
      /**
       * The layer its profile stands on. It is a moved snapshot's, or made of `profile`:
       * that of a snapshot v1 deleted and still kept for the session.
       */
      readonly layer: { readonly id: string; readonly profile: string | null } | null;
      readonly proxy: ProxyConfig | null;
      readonly createdAt: Date;
      /** What its browser wrote above its layer. */
      readonly upper: string;
      readonly files: string | null;
      /** It was running when v1 stopped, and is as its browser left it. */
      readonly wasRunning: boolean;
    }
  | {
      readonly kind: "token";
      readonly id: string;
      readonly name: string;
      readonly accountId: string;
      readonly scopes: ReadonlyArray<Scope>;
      /** What it is held to; all its account reaches, without. */
      readonly resources: TokenResources | null;
      readonly createdAt: Date;
      readonly expiresAt: Date | null;
      /** v1's digest of it, which it is kept with; none for one made anew. */
      readonly digest: string | null;
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
  /** How much v2 has already and is left as it is. */
  readonly moved: number;
  readonly skipped: ReadonlyArray<Named>;
  /** What is moved, and is not in v2 quite what it was in v1. */
  readonly notes: ReadonlyArray<Named>;
  /** What cannot be moved as things are. With any of these, nothing is moved. */
  readonly conflicts: ReadonlyArray<Named>;
}

/** Every scope, in the order a token's are told. */
const SCOPES_ORDER: ReadonlyArray<Scope> = [
  "sessions:read",
  "sessions:write",
  "snapshots:read",
  "snapshots:write",
  "workspaces:read",
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

/**
 * A v1 id as v2's nodes write ids, which is how a snapshot and a session are known
 * everywhere in v2: the same UUID without its dashes.
 */
export const nodeId = (v1Id: string) => v1Id.replaceAll("-", "");

/**
 * What tells one v1 from another, as an id v2 takes. v1 wrote 32 random hex digits, which
 * are no UUID of any version: they are made one of version 8, which is for what is made of
 * something else, by the two places that say so.
 */
export const installId = (bare: string) => {
  const hex = bare.toLowerCase();
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  const made = `${hex.slice(0, 12)}8${hex.slice(13, 16)}${variant}${hex.slice(17)}`;
  return [
    made.slice(0, 8),
    made.slice(8, 12),
    made.slice(12, 16),
    made.slice(16, 20),
    made.slice(20),
  ].join("-");
};

/**
 * What moving v1 into v2 comes to: what is made, what is left where it is and why, and
 * what stands in the way. Everything keeps the id it had in v1, so what v2 has under an
 * id of v1's is what was moved before, unless it was made at another moment: then it is
 * something else, and in the way.
 */
export const plan = (v1: V1Data, known: Known, choices: Choices, now: Date): Plan => {
  const steps: Step[] = [];
  const skipped: Named[] = [];
  const notes: Named[] = [];
  const conflicts: Named[] = [];
  let moved = 0;

  /** Whether v2 has yet to be given what a step makes. */
  const pending = (made: Made, id: string, createdAt: Date, label: string) => {
    const there = known.made.get(key(made, id));
    if (there === undefined) {
      return true;
    }
    if (there.getTime() === createdAt.getTime()) {
      moved += 1;
    } else {
      conflicts.push({
        what: made,
        label,
        reason: `v2 has another ${made} under its id ${id}, made at another moment`,
      });
    }
    return false;
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
  const carried = choices.tokens === "drop" ? [] : tokens;
  if (choices.tokens === "drop") {
    for (const token of tokens) {
      skipped.push({ what: "token", label: token.name, reason: "--tokens drop" });
    }
  }

  /** The account a user of v1 is in v2: their own, or the one v2 has for their address. */
  const accounts = new Map<string, string>();
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
    const joins = known.people.get(user.email.toLowerCase());
    if (joins !== undefined && joins !== user.id) {
      accounts.set(user.id, joins);
      notes.push({
        what: "user",
        label: user.displayName,
        reason: `v2 has an account for ${user.email} already, which stays as it is and is theirs${user.passwordHash === null && user.totpSecret === null ? "" : ", with what they sign in with there and not their password or second factor of v1"}`,
      });
      continue;
    }
    accounts.set(user.id, user.id);
    if (pending("account", user.id, user.createdAt, user.displayName)) {
      steps.push({
        kind: "person",
        id: user.id,
        name: user.displayName,
        email: user.email,
        admin: user.isSystemAdmin,
        disabledAt: user.disabledAt,
        createdAt: user.createdAt,
        password: user.passwordHash,
        secondFactor: user.totpSecret,
      });
    }
  }

  for (const tenant of shared) {
    if (pending("workspace", tenant.id, tenant.createdAt, tenant.displayName)) {
      steps.push({
        kind: "workspace",
        id: tenant.id,
        name: tenant.displayName,
        createdAt: tenant.createdAt,
      });
    }
  }

  /** Lets an account into a workspace, unless it is in it or let in already. */
  const admitted = new Set<string>();
  /** The accounts that are in some workspace. */
  const inAWorkspace = new Set<string>();
  const admit = (workspaceId: string, accountId: string, label: string, admin: boolean) => {
    const member = `${workspaceId}:${accountId}`;
    if (admitted.has(member)) {
      return;
    }
    admitted.add(member);
    inAWorkspace.add(accountId);
    if (known.members.has(member)) {
      moved += 1;
    } else {
      steps.push({
        kind: "member",
        workspaceId,
        accountId,
        label,
        role: admin ? "admin" : "member",
      });
    }
  };

  // A token of v2 is some account's, and a shared tenant's were nobody's: a service account
  // of the workspace bears them, where there are any. It has the tenant's id, an account's
  // as it was a tenant's, since it stands for the tenant where a token is asked whose it is.
  for (const tenant of shared) {
    const borne = carried.filter((token) => token.tenantId === tenant.id);
    if (borne.length === 0) {
      continue;
    }
    const name = `${tenant.displayName} tokens (from v1)`;
    if (pending("account", tenant.id, tenant.createdAt, name)) {
      steps.push({
        kind: "bearer",
        id: tenant.id,
        name,
        admin: false,
        createdAt: tenant.createdAt,
      });
    }
    admit(
      tenant.id,
      tenant.id,
      `${name} in ${tenant.displayName}`,
      // Who is in a workspace is for an admin of it to say.
      borne.some((token) => token.scopes.includes("tenant:write")),
    );
  }
  const install = installId(v1.install.installId);
  if (carried.some((token) => token.tenantId === null)) {
    const name = "Admin tokens (from v1)";
    if (pending("account", install, v1.install.createdAt, name)) {
      steps.push({
        kind: "bearer",
        id: install,
        name,
        admin: true,
        createdAt: v1.install.createdAt,
      });
    }
  }

  for (const membership of v1.memberships) {
    const tenant = live.get(membership.tenantId);
    const user = users.get(membership.userId);
    const account = accounts.get(membership.userId);
    // A personal tenant is its owner's own account in v2, which nobody is a member of.
    if (
      tenant === undefined ||
      tenant.ownerUserId !== null ||
      user === undefined ||
      account === undefined
    ) {
      continue;
    }
    admit(
      tenant.id,
      account,
      `${user.displayName} in ${tenant.displayName}`,
      user.isSystemAdmin || membership.scopes.includes("tenant:write"),
    );
  }
  // A system administrator of v1 held every scope of every shared tenant without being a
  // member of it. An admin of v2 reaches a workspace it is in no other way with a token, or
  // with an app's grant, that is not one of an admin's.
  for (const user of v1.users) {
    const account = accounts.get(user.id);
    if (!user.isSystemAdmin || account === undefined) {
      continue;
    }
    for (const tenant of shared) {
      admit(tenant.id, account, `${user.displayName} in ${tenant.displayName}`, true);
    }
  }

  /**
   * Whose what a tenant had is: the workspace's, and nobody's in particular, for a shared
   * tenant, and its owner's own for a personal one.
   */
  const owner = (tenantId: string) => {
    const tenant = live.get(tenantId);
    return tenant === undefined || tenant.ownerUserId === null
      ? { accountId: null, workspaceId: tenantId }
      : { accountId: accounts.get(tenant.ownerUserId) ?? null, workspaceId: null };
  };
  /** Whether what a tenant had has someone to be of: a personal one's owner may not be moved. */
  const owned = (tenantId: string) => {
    const { accountId, workspaceId } = owner(tenantId);
    return accountId !== null || workspaceId !== null;
  };

  let onNode = false;
  const kept = new Set<string>();
  for (const snapshot of snapshots) {
    if (!owned(snapshot.tenantId)) {
      // Its owner is in the way already, and said to be.
      continue;
    }
    kept.add(snapshot.id);
    if (!pending("snapshot", nodeId(snapshot.id), snapshot.createdAt, snapshot.name)) {
      continue;
    }
    if (snapshot.profile === null) {
      conflicts.push({
        what: "snapshot",
        label: snapshot.name,
        reason: "its profile is not below v1's cold root: is --v1-cold-root the right directory?",
      });
      continue;
    }
    onNode = true;
    steps.push({
      kind: "snapshot",
      id: nodeId(snapshot.id),
      name: snapshot.name,
      description: snapshot.description,
      tags: Object.fromEntries(
        v1.snapshotTags.filter((tag) => tag.of === snapshot.id).map((tag) => [tag.key, tag.value]),
      ),
      ...owner(snapshot.tenantId),
      sessionId:
        snapshot.promotedFromSessionId === null ? null : nodeId(snapshot.promotedFromSessionId),
      createdAt: snapshot.createdAt,
      profile: snapshot.profile,
    });
  }

  const profiles = new Map(v1.snapshots.map((snapshot) => [snapshot.id, snapshot.profile]));
  const keptSessions = new Set<string>();
  for (const session of v1.sessions) {
    const label = session.label ?? session.id;
    // What v1 removed is gone, and it tells of that itself.
    if (session.expiredAt !== null || session.status === "expired") {
      continue;
    }
    const left =
      session.status === "deleted"
        ? "it was deleted in v1"
        : session.status === "creating"
          ? "v1 never finished making it"
          : !live.has(session.tenantId)
            ? "its tenant was deleted"
            : choices.sessions === "drop"
              ? "--sessions drop"
              : session.status === "failed" && session.upper === null
                ? "it failed in v1 and left no profile"
                : undefined;
    if (left !== undefined) {
      skipped.push({ what: "session", label, reason: left });
      continue;
    }
    if (!owned(session.tenantId)) {
      continue;
    }
    keptSessions.add(session.id);
    if (!pending("session", nodeId(session.id), session.createdAt, label)) {
      continue;
    }
    const base = session.baseSnapshotId;
    const upper = session.upper;
    const routed = routingOf(session.proxyConfig);
    const inTheWay =
      upper === null
        ? "its profile is not below v1's store root: is --v1-store-root the right directory?"
        : session.mounted
          ? "its profile is still mounted, so its browser may be writing it: stop v1's sessions, or the machine, first"
          : base !== null && !kept.has(base) && (profiles.get(base) ?? null) === null
            ? "the snapshot its profile stands on is not below v1's cold root"
            : routed === undefined
              ? "its routing is not what v1 writes, and is not read"
              : undefined;
    if (inTheWay !== undefined || upper === null || routed === undefined) {
      conflicts.push({ what: "session", label, reason: inTheWay ?? "it is not read" });
      continue;
    }
    onNode = true;
    steps.push({
      kind: "session",
      id: nodeId(session.id),
      label: session.label,
      tags: Object.fromEntries(
        v1.sessionTags.filter((tag) => tag.of === session.id).map((tag) => [tag.key, tag.value]),
      ),
      ...owner(session.tenantId),
      snapshotId: base !== null && kept.has(base) ? nodeId(base) : null,
      layer:
        base === null
          ? null
          : { id: nodeId(base), profile: kept.has(base) ? null : (profiles.get(base) ?? null) },
      proxy: routed.proxy,
      createdAt: session.createdAt,
      upper,
      files: session.files,
      wasRunning: session.status === "running",
    });
  }
  if (onNode && known.node?.known !== true) {
    conflicts.push({
      what: "node",
      label: known.node?.name ?? "none",
      reason:
        known.node === undefined
          ? "there are snapshots or sessions to move and no node to take them: say --node and --node-store"
          : "the control plane knows no node of that name: start its executor first, so that it registers",
    });
  }

  let secrets = false;
  for (const token of carried) {
    const { scopes, unknown } = scopesOf(token.scopes);
    if (unknown.length > 0) {
      conflicts.push({
        what: "token",
        label: token.name,
        reason: `v2 has no scope for ${unknown.join(", ")}`,
      });
      continue;
    }
    const tenant = token.tenantId === null ? undefined : live.get(token.tenantId);
    // A shared tenant's bearer has the tenant's id, and a personal tenant's tokens are its
    // owner's own.
    const accountId =
      tenant === undefined
        ? install
        : tenant.ownerUserId === null
          ? tenant.id
          : accounts.get(tenant.ownerUserId);
    const grants = v1.grants.filter((grant) => grant.tokenId === token.id);
    const reached = (type: "session" | "snapshot", among: ReadonlySet<string>) =>
      grants
        .filter((grant) => grant.resourceType === type && among.has(grant.resourceId))
        .map((grant) => nodeId(grant.resourceId));
    const resources =
      token.resourceMode === "all"
        ? null
        : {
            workspaces: [],
            sessions: reached("session", keptSessions),
            snapshots: reached("snapshot", kept),
          };
    const left =
      resources === null
        ? 0
        : grants.length - resources.sessions.length - resources.snapshots.length;
    if (left > 0) {
      skipped.push({
        what: "token",
        label: token.name,
        reason: `${left} of the sessions and snapshots it was held to are not moved, and it reaches the rest alone`,
      });
    }
    // Without an account, its owner is in the way already, and said to be.
    if (accountId === undefined) {
      continue;
    }
    const owner = tenant?.ownerUserId ?? null;
    if (owner !== null && resources === null && inAWorkspace.has(accountId)) {
      notes.push({
        what: "token",
        label: token.name,
        reason:
          "it reached its owner's personal tenant alone, and as their own in v2 it reaches the workspaces they are in as well: v2 holds no token to what is its account's own",
      });
    }
    if (
      tenant === undefined &&
      resources === null &&
      tenants.some((one) => one.ownerUserId !== null)
    ) {
      notes.push({
        what: "token",
        label: token.name,
        reason:
          "it reached every shared tenant and no personal one, and as an admin's in v2 it reaches what is each person's own as well: v2 holds an admin to nothing less",
      });
    }
    if (!pending("token", token.id, token.createdAt, token.name)) {
      continue;
    }
    secrets ||= choices.tokens === "reissue";
    steps.push({
      kind: "token",
      id: token.id,
      name: token.name,
      accountId,
      scopes,
      resources,
      createdAt: token.createdAt,
      expiresAt: token.expiresAt,
      digest: choices.tokens === "keep" ? token.tokenHash : null,
    });
  }
  if (secrets && !known.secretsFile) {
    conflicts.push({
      what: "tokens",
      label: "--tokens reissue",
      reason: "the secrets of the new tokens have nowhere to go: say --secrets-file",
    });
  }

  for (const [table, reason] of Object.entries(WITHOUT_A_HOME)) {
    const count = v1.withoutAHome[table as WithoutAHome];
    if (count > 0) {
      skipped.push({ what: table, label: `${count} rows`, reason });
    }
  }

  return { steps, moved, skipped, notes, conflicts };
};
