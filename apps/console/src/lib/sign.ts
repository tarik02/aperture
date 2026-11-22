import { useSyncExternalStore } from "react";
import { onTokenChangedElsewhere, token } from "#/lib/token.ts";

const CHANNEL = "aperture.console.sign";

const listeners = new Set<() => void>();

/** How many times who is signed in changed from outside what this page did itself. */
let changes = 0;

/** Whether this page knows someone to be signed in: only then is a refusal news. */
let signedIn = false;

const changed = () => {
  changes += 1;
  for (const listener of listeners) {
    listener();
  }
};

// The other tabs of this browser carry the same cookies: what one of them does to who is
// signed in, it tells the rest. A tab hears what is news to it: that nobody is signed in
// where it knew someone, and that someone is where it knew nobody. Anything else would
// take the way in from under whoever is on it.
const channel = typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel(CHANNEL);
channel?.addEventListener("message", (event) => {
  // A tab that is signed in with a token carries it itself: the cookies are not what
  // signs it in, and what becomes of them is nothing to it.
  if (token() === undefined && (event.data === "out") === signedIn) {
    signedIn = false;
    changed();
  }
});

/** Tells the other tabs that someone signed in here, or that nobody is signed in any more. */
export const tellSigned = (which: "in" | "out") => {
  channel?.postMessage(which);
};

/** Notes that someone is known to be signed in here. */
export const noteSignedIn = () => {
  signedIn = true;
};

/**
 * Has this page start over with nothing of whoever was signed in, where that changed
 * without its doing: another tab signed in or out with a token.
 */
export const signChanged = () => {
  signedIn = false;
  changed();
};

/**
 * Hears that the control plane knows nobody where this page knew someone: they were signed
 * out elsewhere, or what signed them in ran out. This page and the others start over.
 */
export const refusedHere = () => {
  if (!signedIn) {
    return;
  }
  tellSigned("out");
  signChanged();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Hears each such change, before what is shown is made anew. */
export const onSignChange = (listener: () => void) => {
  const unsubscribe = subscribe(listener);
  return () => void unsubscribe();
};

/** Changes whenever who is signed in changed from outside: what is shown is then made anew. */
export const useSignChanges = () => useSyncExternalStore(subscribe, () => changes);

// Another tab signed in or out with a token, which the browser keeps for all of them.
onTokenChangedElsewhere(signChanged);
