/**
 * A bar to move the window by, where what is shown has no title bar of its own. It is there
 * only in an installed window whose system title bar is given to the page.
 */
export function WindowTitlebar({
  over = false,
}: {
  /** Over the page's edge, not above it. */ over?: boolean;
}) {
  return <div data-app-window-titlebar={over ? "over" : ""} aria-hidden />;
}
