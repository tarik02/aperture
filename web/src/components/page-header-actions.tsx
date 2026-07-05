import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type PageHeaderActionsProps = {
  children: ReactNode;
};

export function PageHeaderActions({ children }: PageHeaderActionsProps) {
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setTarget(document.getElementById("app-header-actions"));
  }, []);

  if (!target) {
    return null;
  }

  return createPortal(children, target);
}
