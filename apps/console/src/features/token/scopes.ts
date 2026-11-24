import type { Scope } from "@aperture-browser/control-api";

/** What each scope lets a token do, in words for whoever ticks it. */
export const SCOPES: ReadonlyArray<{ readonly scope: Scope; readonly lets: string }> = [
  { scope: "sessions:read", lets: "See sessions and watch them" },
  { scope: "sessions:write", lets: "Create, drive, change and delete sessions" },
  { scope: "snapshots:read", lets: "See snapshots" },
  { scope: "snapshots:write", lets: "Save, change and delete snapshots" },
  { scope: "workspaces:read", lets: "See workspaces and who is in them" },
  { scope: "workspaces:write", lets: "Create workspaces and say who is in them" },
  { scope: "tokens:write", lets: "See, make and revoke API tokens" },
  { scope: "events:read", lets: "See what was done, and by whom" },
  { scope: "admin", lets: "What only an admin does: nodes and accounts" },
];

/**
 * What the API lets whoever holds a scope do besides what it names: writing something reads
 * it, and an admin reads the events. A scope is ticked with what it brings, so that what is
 * shown and kept is what is had.
 */
const BRINGS: Partial<Record<Scope, Scope>> = {
  "sessions:write": "sessions:read",
  "snapshots:write": "snapshots:read",
  "workspaces:write": "workspaces:read",
  admin: "events:read",
};

/** Scopes with all they bring, in the order they are told in. */
export const withBrought = (scopes: ReadonlyArray<Scope>) =>
  SCOPES.map((one) => one.scope).filter((scope) =>
    scopes.some((held) => held === scope || BRINGS[held] === scope),
  );

/**
 * What is ticked once one scope is ticked or not: ticking it ticks what it brings, and
 * unticking it unticks what brings it, which is not had without it.
 */
export const ticked = (scopes: ReadonlyArray<Scope>, scope: Scope, checked: boolean) =>
  checked
    ? withBrought([...scopes, scope])
    : scopes.filter((held) => held !== scope && BRINGS[held] !== scope);
