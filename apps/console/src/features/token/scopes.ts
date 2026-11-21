import type { Scope } from "@aperture-browser/control-api";

/** What each scope lets a token do, in words for whoever ticks it. */
export const SCOPES: ReadonlyArray<{ readonly scope: Scope; readonly lets: string }> = [
  { scope: "sessions:read", lets: "See sessions and watch them" },
  { scope: "sessions:write", lets: "Create, drive, change and delete sessions" },
  { scope: "snapshots:read", lets: "See snapshots" },
  { scope: "snapshots:write", lets: "Save, change and delete snapshots" },
  { scope: "workspaces:write", lets: "Create workspaces and say who is in them" },
  { scope: "tokens:write", lets: "See, make and revoke API tokens" },
  { scope: "admin", lets: "What only an admin does: nodes and accounts" },
];
