import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { call } from "#/lib/api.ts";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { queryKeys } from "#/lib/query-keys.ts";

/** How often the nodes are asked for again: one that falls silent is told so soon. */
const ASKED_EVERY = 5000;

export function useNodesQuery() {
  return useQuery({
    queryKey: queryKeys.nodes,
    queryFn: () => call((api) => api.nodes.list()),
    refetchInterval: ASKED_EVERY,
  });
}

export function useRegistrationTokensQuery() {
  return useQuery({
    queryKey: queryKeys.registrationTokens,
    queryFn: () => call((api) => api.nodes.registrationTokens()),
  });
}

export function useCreateRegistrationTokenMutation() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      call((api) => api.nodes.createRegistrationToken({ payload: { name } })),
    onError: (error) => toastMutationError(error, "The token was not made"),
    onSettled: () => queries.invalidateQueries({ queryKey: queryKeys.registrationTokens }),
  });
}
