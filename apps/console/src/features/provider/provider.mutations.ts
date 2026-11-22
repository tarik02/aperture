import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { call, told } from "#/lib/api.ts";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { queryKeys } from "#/lib/query-keys.ts";
import { PROVIDERS_KEY } from "#/features/provider/provider.queries.ts";

/** What is said of a provider, as the form has it. */
export interface ProviderSaid {
  readonly name: string;
  readonly issuer: string;
  readonly clientId: string;
  /** Empty for the secret it has. */
  readonly clientSecret: string;
  readonly scopes: ReadonlyArray<string>;
  readonly provision: boolean;
  readonly domains: ReadonlyArray<string>;
  readonly enabled: boolean;
}

/** Why a provider was refused, each reason a sentence, where the control plane gave any. */
export const problemsOf = (error: unknown): ReadonlyArray<string> =>
  typeof error === "object" &&
  error !== null &&
  "problems" in error &&
  Array.isArray(error.problems)
    ? error.problems.filter((problem): problem is string => typeof problem === "string")
    : [];

/** The people page tells what each person signs in through, by what the providers are called. */
const useStale = () => {
  const queries = useQueryClient();
  return () =>
    Promise.all([
      queries.invalidateQueries({ queryKey: PROVIDERS_KEY }),
      queries.invalidateQueries({ queryKey: queryKeys.accounts }),
    ]);
};

/** Adds a provider. What it is refused for is the form's to say. */
export function useCreateProviderMutation() {
  const stale = useStale();
  return useMutation({
    mutationFn: ({ id, ...said }: ProviderSaid & { readonly id: string }) =>
      call((api) => api.providers.create({ payload: { id, ...said } })),
    onSettled: stale,
  });
}

/** Changes a provider. What it is refused for is the form's to say. */
export function useChangeProviderMutation() {
  const stale = useStale();
  return useMutation({
    mutationFn: ({ id, ...said }: ProviderSaid & { readonly id: string }) =>
      call((api) => api.providers.change({ params: { id }, payload: said })),
    onSettled: stale,
  });
}

export function useEnableProviderMutation() {
  const stale = useStale();
  return useMutation({
    mutationFn: ({ id, enabled }: { readonly id: string; readonly enabled: boolean }) =>
      call((api) => api.providers.change({ params: { id }, payload: { enabled } })),
    onError: (error, { enabled }) => {
      const [first] = problemsOf(error);
      // Why it is not reached says more than that it is not.
      toast.error(
        first ??
          told(error, enabled ? "The provider was not enabled" : "The provider was not disabled"),
      );
    },
    onSettled: stale,
  });
}

export function useRemoveProviderMutation() {
  const stale = useStale();
  return useMutation({
    mutationFn: (id: string) => call((api) => api.providers.remove({ params: { id } })),
    onError: (error) => toastMutationError(error, "The provider was not removed"),
    onSettled: stale,
  });
}

/** Asks a provider how it is reached. What comes of it is the form's to show. */
export function useCheckProviderMutation() {
  return useMutation({
    mutationFn: (issuer: string) => call((api) => api.providers.check({ payload: { issuer } })),
  });
}
