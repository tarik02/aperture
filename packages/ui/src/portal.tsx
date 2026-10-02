"use client";

import { createContext, useContext, type ReactNode } from "react";

// Without a provider, portals keep Base UI's default container, the document body.
const PortalContainerContext = createContext<HTMLElement | undefined>(undefined);

export function PortalContainerProvider({
  container,
  children,
}: {
  container: HTMLElement;
  children: ReactNode;
}) {
  return (
    <PortalContainerContext.Provider value={container}>{children}</PortalContainerContext.Provider>
  );
}

export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContainerContext);
}
