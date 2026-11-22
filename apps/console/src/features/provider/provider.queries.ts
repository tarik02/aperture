import { useQuery } from "@tanstack/react-query";
import { call } from "#/lib/api.ts";

/** The providers are this feature's alone: nothing else's answers go stale with them. */
export const PROVIDERS_KEY = ["sign-in-providers"] as const;

const listProviders = () => call((api) => api.providers.list());

export type Provider = Awaited<ReturnType<typeof listProviders>>["providers"][number];

export function useProvidersQuery() {
  return useQuery({ queryKey: PROVIDERS_KEY, queryFn: listProviders });
}
