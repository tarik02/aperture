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

/**
 * The name a session's picture moves under, from its card to where the workbench shows
 * it. One name: only the card that was pressed has it, and only one workbench is open.
 */
export const SESSION_PICTURE = "session-picture";

/** How long the card's picture softens before it starts to move, so that what grows is soft already. */
export const SOFTEN_MS = 120;
