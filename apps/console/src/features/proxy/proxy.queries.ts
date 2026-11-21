import type { ProxyConfig } from "@aperture-browser/control-api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { call } from "#/lib/api.ts";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { queryKeys } from "#/lib/query-keys.ts";

export function useSessionProxyQuery(sessionId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.proxy(sessionId),
    queryFn: () => call((api) => api.sessions.proxy({ params: { id: sessionId } })),
    enabled,
    // Edited from what is kept now, and not from what was when the dialog last opened.
    gcTime: 0,
  });
}

export function useSetSessionProxyMutation(sessionId: string) {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (proxy: ProxyConfig | null) =>
      call((api) => api.sessions.setProxy({ params: { id: sessionId }, payload: { proxy } })),
    onSuccess: () => toast.success("Routing changed"),
    onError: (error) => toastMutationError(error, "The routing was not changed"),
    onSettled: () => queries.invalidateQueries({ queryKey: queryKeys.proxy(sessionId) }),
  });
}
