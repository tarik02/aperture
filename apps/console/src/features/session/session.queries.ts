import { useQuery } from "@tanstack/react-query";
import * as Schema from "effect/Schema";
import { useMay } from "#/features/auth/access.ts";
import { every } from "#/lib/answering.ts";
import { call } from "#/lib/api.ts";
import { queryKeys } from "#/lib/query-keys.ts";

export type Session = Awaited<ReturnType<typeof listSessions>>[number];

const listSessions = () => call((api) => api.sessions.list({ query: {} }));

/** How often sessions are asked for again: what their nodes say of them is not pushed here yet. */
const ASKED_EVERY = 2000;
/** How often a card asks what its session shows. */
const SHOWN_EVERY = 5000;

export function useSessionsQuery() {
  return useQuery({
    queryKey: queryKeys.sessions,
    queryFn: listSessions,
    // Not asked for by a token that is refused them: the answer would be the same each time.
    enabled: useMay("sessions:read"),
    refetchInterval: every(ASKED_EVERY),
  });
}

export function useSessionQuery(id: string) {
  return useQuery({
    queryKey: queryKeys.session(id),
    queryFn: () => call((api) => api.sessions.get({ params: { id } })),
    refetchInterval: every(ASKED_EVERY),
  });
}

/** A page a session has open, as the session's own `targets` route tells it. */
const Target = Schema.Struct({
  id: Schema.String,
  tab: Schema.Number,
  title: Schema.String,
  url: Schema.String,
});
export type Target = typeof Target.Type;

const decodeTargets = Schema.decodeUnknownPromise(Schema.Array(Target));

/**
 * The pages a running session has open, asked of the session itself at its path: the
 * browser carries what lets it in.
 */
export function useSessionTargetsQuery(session: Session) {
  const path = session.path;
  return useQuery({
    queryKey: queryKeys.targets(session.id),
    queryFn: async () => {
      const answer = await fetch(`${path}/targets`);
      if (!answer.ok) {
        throw new Error(`the session answered ${answer.status}`);
      }
      return { targets: await decodeTargets(await answer.json()), at: Date.now() };
    },
    enabled: path !== null && session.observedState === "running",
    refetchInterval: SHOWN_EVERY,
  });
}
