import type { ShareRole } from "@aperture-browser/control-api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { call } from "#/lib/api.ts";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { queryKeys } from "#/lib/query-keys.ts";

const sharesOf = (sessionId: string) => [...queryKeys.session(sessionId), "shares"] as const;

/** The share links into a session, asked for while they are looked at. */
export function useSharesQuery(sessionId: string, enabled: boolean) {
  return useQuery({
    queryKey: sharesOf(sessionId),
    queryFn: () => call((api) => api.shares.list({ params: { id: sessionId } })),
    enabled,
  });
}

/** A share link as whoever has its session sees it. */
export type Share = NonNullable<ReturnType<typeof useSharesQuery>["data"]>[number];

type NewShare = {
  /** Whom it is for; nobody named, without. */
  name: string | undefined;
  role: ShareRole;
  /** The number of the one tab it shows; the whole session, without. */
  tab: number | undefined;
  /** How long it is good for; for as long as it is not taken back, without. */
  expiresInHours: number | undefined;
};

export function useCreateShareMutation(sessionId: string) {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (share: NewShare) =>
      call((api) => api.shares.create({ params: { id: sessionId }, payload: share })),
    onError: (error) => toastMutationError(error, "The link was not made"),
    onSettled: () => queries.invalidateQueries({ queryKey: sharesOf(sessionId) }),
  });
}

export function useRevokeShareMutation(sessionId: string) {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (shareId: string) =>
      call((api) => api.shares.revoke({ params: { id: sessionId, shareId } })),
    onError: (error) => toastMutationError(error, "The link was not revoked"),
    onSettled: () => queries.invalidateQueries({ queryKey: sharesOf(sessionId) }),
  });
}
