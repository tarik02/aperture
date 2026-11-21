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
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { queryKeys } from "#/lib/query-keys.ts";
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
    queryFn: () => call((api) => api.accounts.current()),
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

export function useEnrolMutation() {
  return useMutation({
    mutationFn: enrol,
    onError: (error) => toastMutationError(error, "The second factor was not set up"),
  });
}

export function useConfirmEnrolmentMutation() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: giveCode,
    onError: (error) => toastMutationError(error, "The code was not taken"),
    onSuccess: () => queries.invalidateQueries({ queryKey: queryKeys.person }),
  });
}

export function useRenewBackupCodesMutation() {
  return useMutation({
    mutationFn: renewBackupCodes,
    onError: (error) => toastMutationError(error, "No new backup codes were made"),
  });
}

export function useTurnSecondFactorOffMutation() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: turnSecondFactorOff,
    onError: (error) => toastMutationError(error, "The second factor was not turned off"),
    onSuccess: () => queries.invalidateQueries({ queryKey: queryKeys.person }),
  });
}
