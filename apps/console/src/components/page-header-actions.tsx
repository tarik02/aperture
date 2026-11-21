import { createContext, useContext } from "react";
import { createPortal } from "react-dom";

/** Where the title bar has room for what a page does: the page puts its buttons there. */
export const PageHeaderActionsTarget = createContext<HTMLElement | null>(null);

export function PageHeaderActions({ children }: { children: React.ReactNode }) {
  const target = useContext(PageHeaderActionsTarget);
  return target === null ? null : createPortal(children, target);
}
