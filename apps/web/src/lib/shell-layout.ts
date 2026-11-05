import { searchFlag } from "#/lib/search-flag.ts";
import type { SidebarLayout } from "#/stores/sidebar.ts";

/** The app shell variant, including the standalone pages that render without app chrome. */
export type ShellLayout = SidebarLayout | "bare";

/**
 * Standalone pages and an embedded workbench render without app chrome; the workbench shares the
 * app sidebar but keeps its own open state for it.
 */
export function shellLayout(pathname: string, search: object): ShellLayout {
  if (/^\/(?:invite|share|oauth\/consent)\/?$/.test(pathname)) {
    return "bare";
  }
  if (/^\/-\/sessions\/[^/]+\/?$/.test(pathname)) {
    return searchFlag((search as { embed?: unknown }).embed) ? "bare" : "workbench";
  }
  return "page";
}
