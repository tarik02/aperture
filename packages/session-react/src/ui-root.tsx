import { useEffect, useState, type ReactNode } from "react";
import { TooltipProvider } from "@aperture-browser/ui/components/tooltip";
import { PortalContainerProvider } from "@aperture-browser/ui/portal";
import { cn } from "@aperture-browser/ui/utils";

export type ApertureTheme = "light" | "dark" | "system";

export interface ApertureUIRootProps {
  readonly theme?: ApertureTheme;
  readonly className?: string;
  readonly children?: ReactNode;
}

export function ApertureUIRoot({ theme = "system", className, children }: ApertureUIRootProps) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const dark = useDarkTheme(theme);

  return (
    <div
      ref={setRoot}
      className={cn("aperture-root relative h-full w-full", dark && "dark", className)}
    >
      {root ? (
        <PortalContainerProvider container={root}>
          <TooltipProvider>{children}</TooltipProvider>
        </PortalContainerProvider>
      ) : null}
    </div>
  );
}

function useDarkTheme(theme: ApertureTheme): boolean {
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    if (theme !== "system") {
      return;
    }
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [theme]);

  return theme === "dark" || (theme === "system" && systemDark);
}
