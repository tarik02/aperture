/**
 * Whether a change of what is shown may fade or move into place. Not for whoever asked
 * for less motion, and not in a page nobody looks at: a transition there never ends, and
 * the page takes no clicks while it waits.
 */
export const mayTransition = () =>
  "startViewTransition" in document &&
  document.visibilityState === "visible" &&
  document.hasFocus() &&
  !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The name a session's picture moves under, from its card into its workbench. */
export const sessionPictureName = (sessionId: string) => `session-${sessionId}`;
