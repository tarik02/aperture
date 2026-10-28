import { useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PageHeaderActionsTarget } from "#/components/page-header-context.ts";

type PageHeaderActionsProps = {
  children: ReactNode;
};

export function PageHeaderActions({ children }: PageHeaderActionsProps) {
  const target = useContext(PageHeaderActionsTarget);

  if (!target) {
    return null;
  }

  return createPortal(children, target);
}
