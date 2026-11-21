/** Every query's key, so that what changes one thing says which answers are stale. */
export const queryKeys = {
  account: ["account"] as const,
  sessions: ["sessions"] as const,
  session: (id: string) => ["sessions", id] as const,
  proxy: (id: string) => ["sessions", id, "proxy"] as const,
  targets: (id: string) => ["sessions", id, "targets"] as const,
  snapshots: ["snapshots"] as const,
  nodes: ["nodes"] as const,
  registrationTokens: ["registration-tokens"] as const,
  accounts: ["accounts"] as const,
  tokens: ["tokens"] as const,
};
