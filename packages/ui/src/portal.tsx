"use client";

import { createContext, useContext, type ReactNode } from "react";

const PortalContainerContext = createContext<HTMLElement | null>(null);

/**
 * Renders the popups below it (menus, tooltips, dialogs) into `container` rather than
 * `document.body`, so they stay inside an embedded root and its styles.
 */
export function PortalContainerProvider({
  container,
  children,
}: {
  container: HTMLElement | null;
  children: ReactNode;
}) {
  return (
    <PortalContainerContext.Provider value={container}>{children}</PortalContainerContext.Provider>
  );
}

/** Where popups render; undefined means `document.body`. */
export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContainerContext) ?? undefined;
}
