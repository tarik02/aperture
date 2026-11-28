import { keepPreviousData, useQuery } from "@tanstack/react-query";
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

/**
 * When what a session keeps of itself was last made: as it was suspended last. Its node
 * tells of it every few seconds while it rests, which is no new rest: what is kept is asked
 * for again only when this changes.
 */
export const restedAt = (session: Session) =>
  (session.suspendedSince ?? session.observedAt).epochMilliseconds;

/** A page a session has open, as the session's own `targets` route tells it. */
const Target = Schema.Struct({
  id: Schema.String,
  tab: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  /** It is the tab watched last, which whoever opens the session watches. */
  watched: Schema.optional(Schema.Boolean),
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
    enabled:
      path !== null &&
      (session.observedState === "running" || session.observedState === "restoring"),
    refetchInterval: SHOWN_EVERY,
  });
}

/** The tabs of a session as it was last suspended, as its node keeps them beside their pictures. */
const KeptTabs = Schema.Struct({
  /** The tab watched last, whose picture is the session's own. */
  watched: Schema.NullOr(Schema.Number),
  tabs: Schema.Array(
    Schema.Struct({
      tab: Schema.Number,
      title: Schema.String,
      url: Schema.String,
      /** What kind of picture the tab's icon is; none where its page had none. */
      icon: Schema.NullOr(Schema.String),
      /** Its picture was kept. */
      picture: Schema.Boolean,
    }),
  ),
});
export type KeptTabs = typeof KeptTabs.Type;

const decodeKeptTabs = Schema.decodeUnknownPromise(KeptTabs);

/**
 * The tabs a session that rests had as it was last suspended; none where its node kept
 * none of them, as for one suspended before nodes did. Asked again as it rests anew.
 */
export function useSessionKeptTabsQuery(session: Session) {
  const path = session.path;
  const at = restedAt(session);
  return useQuery({
    queryKey: queryKeys.keptTabs(session.id, at),
    queryFn: async () => {
      const answer = await fetch(`${path}/previews`);
      if (answer.status === 404) {
        return null;
      }
      if (!answer.ok) {
        throw new Error(`the node answered ${answer.status}`);
      }
      return decodeKeptTabs(await answer.json());
    },
    enabled: path !== null && session.observedState === "suspended",
    staleTime: Number.POSITIVE_INFINITY,
    // What it kept as it rested before stays while what it kept now is asked for.
    placeholderData: keepPreviousData,
  });
}
