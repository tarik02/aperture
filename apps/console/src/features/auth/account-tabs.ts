import { useAccess } from "#/features/auth/access.ts";
import { usePersonQuery } from "#/features/auth/auth.queries.ts";
import { useToken } from "#/lib/token.ts";

/** What is the account's own, each kind of it a tab of the account's page with its address. */
export const ACCOUNT_TABS = [
  { id: "security", title: "Security", to: "/-/account/security" },
  { id: "tokens", title: "API tokens", to: "/-/account/tokens" },
  { id: "connections", title: "Connections", to: "/-/account/connections" },
  { id: "settings", title: "Settings", to: "/-/account/settings" },
] as const;

export type AccountTab = (typeof ACCOUNT_TABS)[number];

/**
 * The tabs whoever is signed in is offered. How one signs in is a person's: a token signs
 * in with nothing else. What acts for the account is for whoever may make tokens.
 */
export function useAccountTabs(): ReadonlyArray<AccountTab> {
  const person = usePersonQuery();
  // Whoever signed in with no token is a person: known before they are asked for, so that
  // nothing moves when the answer comes.
  const signsIn = useToken() === undefined && person.data !== null;
  const access = useAccess();
  const acts = access.may("tokens:write");
  const sessions = access.may("sessions:read");
  return ACCOUNT_TABS.filter((tab) =>
    tab.id === "security" ? signsIn : tab.id === "settings" ? sessions : acts,
  );
}
