import { useQuery } from "@tanstack/react-query";
import { call } from "#/lib/api.ts";
import { queryKeys } from "#/lib/query-keys.ts";

/** The control plane that answers: what it runs changes only when it is deployed anew. */
export function useAboutQuery() {
  return useQuery({
    queryKey: queryKeys.about,
    queryFn: () => call((api) => api.about.get()),
    staleTime: Infinity,
  });
}
