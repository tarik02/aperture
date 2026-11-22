import { useQuery } from "@tanstack/react-query";
import { call } from "#/lib/api.ts";
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

const listRegistrationTokens = () => call((api) => api.nodes.registrationTokens());

export type RegistrationToken = Awaited<ReturnType<typeof listRegistrationTokens>>[number];

export function useRegistrationTokensQuery() {
  return useQuery({
    queryKey: queryKeys.registrationTokens,
    queryFn: listRegistrationTokens,
  });
}
