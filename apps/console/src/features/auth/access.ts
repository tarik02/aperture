import { covers, type Scope } from "@aperture-browser/control-api";
import { useMemo } from "react";
import { useAccountQuery } from "#/features/auth/auth.queries.ts";

/** Something that is offered only to whoever may do it: an action, a page. */
export interface Guarded {
  /** What whoever is signed in has to be let do for it to be offered; anyone, without. */
  readonly needs?: Scope | undefined;
}

/**
 * What whoever is signed in may do: all their account does where they signed in as a
 * person, and what the token says where they signed in with one. The API refuses the rest
 * either way: this is for offering nothing that it would.
 */
export function useAccess() {
  const account = useAccountQuery().data;
  return useMemo(() => {
    const scopes = account?.scopes ?? null;
    const resources = account?.resources ?? null;
    const admin = account?.admin === true && covers(scopes, "admin");
    const may = (scope: Scope) => {
      if (account === undefined) {
        return false;
      }
      if (scope === "admin") {
        return admin;
      }
      // An admin reads the events whatever else the token is for.
      return covers(scopes, scope) || (scope === "events:read" && admin);
    };
    return {
      may,
      /** Whether something is offered: what needs nothing is, to anyone. */
      offers: (one: Guarded) => one.needs === undefined || may(one.needs),
      /**
       * Whether sessions are made in a workspace, or with none in the account's own: a
       * token held to resources makes them in the workspaces it names and nowhere else.
       */
      makesSessionsIn: (workspaceId: string | null) =>
        may("sessions:write") &&
        (resources === null ||
          (workspaceId !== null && resources.workspaces.includes(workspaceId))),
      /** Whether tokens are made: a token held to resources makes none. */
      makesTokens: may("tokens:write") && resources === null,
    };
  }, [account]);
}

/** Whether whoever is signed in may do what a scope names. */
export const useMay = (scope: Scope) => useAccess().may(scope);
