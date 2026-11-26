import { useNavigate } from "@tanstack/react-router";
import { type CSSProperties, type MouseEvent, useState } from "react";
import {
  mayTransition,
  noteOpenedPicture,
  SESSION_PICTURE,
  SOFTEN_MS,
} from "#/lib/view-transition.ts";

/**
 * Opens a session from a picture of it: the picture softens, then grows into where the
 * workbench shows the session. For a link that leads there, which still is one to
 * whoever opens it in another tab, and where nothing may move. `tab` is the tab it opens
 * on; the one watched last without.
 */
export function useOpenSession(sessionId: string, picture: string | undefined, tab?: number) {
  const navigate = useNavigate();
  /** Pressed, and on its way into the workbench. */
  const [opening, setOpening] = useState(false);

  const onClick = (event: MouseEvent) => {
    // The workbench goes on showing it until the session draws itself.
    noteOpenedPicture(sessionId, picture);
    if (!mayTransition() || event.metaKey || event.ctrlKey || event.shiftKey) {
      return;
    }
    event.preventDefault();
    setOpening(true);
    setTimeout(() => {
      void navigate({
        to: "/-/sessions/$sessionId",
        params: { sessionId },
        search: tab === undefined ? {} : { tab },
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
