/**
 * Brings what a form's rules say into view where it comes to be: in a dialog that scrolls
 * between its header and buttons, it may be said out of sight.
 */
export const reveal = (said: HTMLElement | null) => {
  said?.scrollIntoView({ block: "nearest" });
};
