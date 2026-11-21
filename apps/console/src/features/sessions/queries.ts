import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { call } from "../../lib/api.ts";

export type Session = Awaited<ReturnType<typeof list>>[number];

const list = () => call((api) => api.sessions.list());

/** How often the sessions are asked for again: what their nodes say of them is not pushed here yet. */
const ASKED_EVERY = 2000;

export const sessionsQuery = queryOptions({
  queryKey: ["sessions"],
  queryFn: list,
  refetchInterval: ASKED_EVERY,
});

export const sessionQuery = (id: string) =>
  queryOptions({
    queryKey: ["sessions", id],
    queryFn: () => call((api) => api.sessions.get({ params: { id } })),
    refetchInterval: ASKED_EVERY,
  });

export const accountQuery = queryOptions({
  queryKey: ["account"],
  queryFn: () => call((api) => api.accounts.current()),
});

export const useCreateSession = () => {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: () => call((api) => api.sessions.create({ payload: {} })),
    onSettled: () => queries.invalidateQueries({ queryKey: ["sessions"] }),
  });
};

export const useSessionChange = (does: "suspend" | "resume" | "delete") => {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => call((api) => api.sessions[does]({ params: { id } })),
    onSettled: () => queries.invalidateQueries({ queryKey: ["sessions"] }),
  });
};
