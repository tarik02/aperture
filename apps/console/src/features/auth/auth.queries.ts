import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { call } from "#/lib/api.ts";
import {
  enrol,
  giveCode,
  passkeys,
  person,
  renewBackupCodes,
  turnSecondFactorOff,
} from "#/lib/identity.ts";
import { queryKeys } from "#/lib/query-keys.ts";
import { noteSignedIn } from "#/lib/sign.ts";
import { useToken } from "#/lib/token.ts";

/**
 * The account that is signed in: the one of the token this browser keeps, or the one its
 * cookies sign in. It fails where neither signs anyone in.
 */
export function useAccountQuery() {
  // Asked anew when the token changes: who is signed in is another then.
  const token = useToken();
  return useQuery({
    queryKey: [...queryKeys.account, token ?? null],
    queryFn: async () => {
      const account = await call((api) => api.accounts.current());
      noteSignedIn();
      return account;
    },
    staleTime: Infinity,
  });
}

/**
 * The person who is signed in, where it is a person: nobody for whoever signed in with a
 * token, which is asked before the cookies are.
 */
export function usePersonQuery() {
  const token = useToken();
  return useQuery({
    queryKey: [...queryKeys.person, token ?? null],
    queryFn: () => (token === undefined ? person() : null),
    staleTime: Infinity,
  });
}

/** The passkeys of the person who is signed in, asked for while they are looked at. */
export function usePasskeysQuery(enabled: boolean) {
  return useQuery({ queryKey: queryKeys.passkeys, queryFn: passkeys, enabled });
}

// What these fail with is said at the field of the form that asked, by the form.

export function useEnrolMutation() {
  return useMutation({
    mutationFn: enrol,
  });
}

export function useConfirmEnrolmentMutation() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: giveCode,
    onSuccess: () => queries.invalidateQueries({ queryKey: queryKeys.person }),
  });
}

export function useRenewBackupCodesMutation() {
  return useMutation({
    mutationFn: renewBackupCodes,
  });
}

export function useTurnSecondFactorOffMutation() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: turnSecondFactorOff,
    onSuccess: () => queries.invalidateQueries({ queryKey: queryKeys.person }),
  });
}
