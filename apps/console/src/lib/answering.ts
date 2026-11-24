import type { Query, QueryClient } from "@tanstack/react-query";
import * as HttpClientError from "effect/http/HttpClientError";
import { useEffect, useSyncExternalStore } from "react";

const SERVER_FAILED = 500;

/**
 * What was asked of Aperture by something other than the API's client, and was not
 * answered: it was not reached, or failed to answer.
 */
export class Unanswered extends Error {
  constructor() {
    super("Aperture is not answering. Try again in a moment.");
  }
}

/** Whether an answer's status is of a server that failed, and not a refusal of what was asked. */
export const failedToAnswer = (status: number) => status >= SERVER_FAILED;

/**
 * Whether a call failed because Aperture did not answer: it was not reached, or it, or
 * what stands before it, answered that it failed. A refusal is an answer, and so is a
 * failure the API has a name for: a node that is out of reach is not Aperture being so.
 */
export const notAnswering = (error: unknown) => {
  if (error instanceof Unanswered) {
    return true;
  }
  if (!HttpClientError.isHttpClientError(error)) {
    return false;
  }
  const { reason } = error;
  // A status the API names no failure for comes as an answer that was not understood.
  return (
    reason._tag === "TransportError" ||
    ("response" in reason && failedToAnswer(reason.response.status))
  );
};

/** The pause before what was not answered is asked again; twice as long after each try. */
const FIRST_PAUSE_MS = 1000;
const LONGEST_PAUSE_MS = 30_000;

interface Answering {
  /** Something a page shows was not answered, and is asked again by itself. */
  readonly down: boolean;
  /** It is being asked again right now. */
  readonly asking: boolean;
  /** A page says so in its own place: nothing else has to. */
  readonly said: boolean;
}

let shown: Answering = { down: false, asking: false, said: false };
const listeners = new Set<() => void>();

let client: QueryClient | undefined;
/** The queries that were not answered and have not been since, by their hashes. */
const unanswered = new Set<string>();
let tries = 0;
let asking = false;
let pause: ReturnType<typeof setTimeout> | undefined;
/** The pages that say so themselves right now. */
let saying = 0;

const show = (next: Answering) => {
  if (next.down === shown.down && next.asking === shown.asking && next.said === shown.said) {
    return;
  }
  shown = next;
  for (const listener of listeners) {
    listener();
  }
};

/** The queries a page still shows that were not answered. */
const waiting = () =>
  client === undefined
    ? []
    : client
        .getQueryCache()
        .getAll()
        .filter((query) => unanswered.has(query.queryHash) && query.isActive());

const rested = (query: Query) => query.state.status === "error";

const ask = () => {
  clearTimeout(pause);
  pause = undefined;
  if (client === undefined || asking) {
    return;
  }
  tries += 1;
  asking = true;
  settle();
  void client
    .refetchQueries({
      type: "active",
      predicate: (query) => unanswered.has(query.queryHash) && rested(query),
    })
    .finally(() => {
      asking = false;
      settle();
    });
};

/** Asks when the pause is over, and at once after it where nobody looked at the page then. */
const askShown = () => {
  pause = undefined;
  if (document.visibilityState === "visible") {
    ask();
  }
};

function settle() {
  const left = waiting();
  if (left.length === 0) {
    // All that was not answered was, or is shown by nothing any more.
    tries = 0;
    clearTimeout(pause);
    pause = undefined;
  } else if (!asking && pause === undefined && left.some(rested)) {
    pause = setTimeout(askShown, Math.min(FIRST_PAUSE_MS * 2 ** tries, LONGEST_PAUSE_MS));
  }
  show({ down: left.length > 0, asking, said: saying > 0 });
}

/**
 * Asks again, by itself, what Aperture did not answer: after a pause that grows with each
 * try, and not while nobody looks at the page. A query that failed is otherwise at rest
 * until something asks it again, and what is shown in its place stays for good.
 */
export const watchAnswering = (queries: QueryClient) => {
  client = queries;
  const unsubscribe = queries.getQueryCache().subscribe((event) => {
    const hash = event.query.queryHash;
    if (event.type === "removed") {
      unanswered.delete(hash);
    } else if (event.type === "updated" && event.action.type === "error") {
      if (notAnswering(event.action.error)) {
        unanswered.add(hash);
      } else {
        unanswered.delete(hash);
      }
    } else if (event.type === "updated" && event.action.type === "success") {
      unanswered.delete(hash);
    }
    settle();
  });
  const looked = () => {
    if (document.visibilityState === "visible" && pause === undefined && waiting().some(rested)) {
      ask();
    }
  };
  document.addEventListener("visibilitychange", looked);
  return () => {
    unsubscribe();
    document.removeEventListener("visibilitychange", looked);
    clearTimeout(pause);
    pause = undefined;
    unanswered.clear();
    client = undefined;
  };
};

/** Asks now, without the rest of the pause. */
export const askNow = () => {
  if (waiting().some(rested)) {
    ask();
  }
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const useAnswering = () => useSyncExternalStore(subscribe, () => shown);

/**
 * Whether what a page cannot do without was not answered: there is nothing of it to show,
 * and Aperture is why. It stays so while it is asked again, which has the query say for a
 * moment that it was never asked.
 */
export const useUnanswered = (query: {
  readonly data: unknown;
  readonly error: unknown;
  readonly isPending: boolean;
}) => {
  const { down } = useAnswering();
  return query.data === undefined && (notAnswering(query.error) || (query.isPending && down));
};

/** Notes that the page says in its own place that Aperture is not answering. */
export const useSaysNotAnswering = () => {
  useEffect(() => {
    saying += 1;
    settle();
    return () => {
      saying -= 1;
      settle();
    };
  }, []);
};

/**
 * How often something is asked again while it is shown. What Aperture did not answer is
 * not asked at that pace: it is asked again with the pauses above, and at this pace once
 * it was answered.
 */
export const every =
  (ms: number) =>
  (query: Pick<Query, "state">): number | false =>
    query.state.status === "error" && notAnswering(query.state.error) ? false : ms;
