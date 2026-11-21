import { useNavigate } from "@tanstack/react-router";
import { type CSSProperties, type MouseEvent, useState } from "react";
import { mayTransition, SESSION_PICTURE, SOFTEN_MS } from "#/lib/view-transition.ts";

/**
 * Opens a session from a picture of it: the picture softens, then grows into where the
 * workbench shows the session. For a link that leads there, which still is one to
 * whoever opens it in another tab, and where nothing may move.
 */
export function useOpenSession(sessionId: string) {
  const navigate = useNavigate();
  /** Pressed, and on its way into the workbench. */
  const [opening, setOpening] = useState(false);

  const onClick = (event: MouseEvent) => {
    if (!mayTransition() || event.metaKey || event.ctrlKey || event.shiftKey) {
      return;
    }
    event.preventDefault();
    setOpening(true);
    setTimeout(() => {
      void navigate({
        to: "/-/sessions/$sessionId",
        params: { sessionId },
        viewTransition: true,
      });
      // Where the link stays on the page, as in the sidebar, its picture is its own again.
      setOpening(false);
    }, SOFTEN_MS);
  };

  /** For whatever holds the picture: the name it moves under, while it is on its way. */
  const moving: CSSProperties | undefined = opening
    ? { viewTransitionName: SESSION_PICTURE }
    : undefined;

  return { opening, onClick, moving };
}
