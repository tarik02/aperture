import { useEffect, useRef } from "react";
import type { Session } from "@aperture-browser/session-client";
import { useSession, useSessionSnapshot } from "../session.tsx";
import { useStored } from "./use-stored.ts";

const FIT_KEY = "aperture.session.fit";

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

/**
 * Has the viewport fit the window, unless that was switched off when this browser was last
 * here, and remembers when it is switched on or off. `follows` is false where the embedder
 * wants targets left at the size they have.
 */
export function useRememberedFit(follows = true) {
  const session = useSession();
  const snapshot = useSessionSnapshot();
  const [remembered, remember] = useStored(FIT_KEY, true, isBoolean);
  const applied = useRef<Session | undefined>(undefined);
  const ready =
    follows &&
    snapshot.connection.state === "open" &&
    snapshot.selected !== undefined &&
    snapshot.features.tabs.write;

  useEffect(() => {
    if (!ready) {
      return;
    }
    if (applied.current !== session) {
      applied.current = session;
      if (remembered && !snapshot.fit) {
        // The tab may be someone's at work in it: its size waits for this member's turn.
        session.setViewport("fit", { whenFree: true });
      }
      return;
    }
    if (snapshot.fit !== remembered) {
      remember(snapshot.fit);
    }
  }, [ready, session, snapshot.fit, remembered, remember]);
}
