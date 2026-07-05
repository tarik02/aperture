import type { CSSProperties, ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { Separator } from "#/components/ui/separator.tsx";
import { useSidebar } from "#/components/ui/sidebar.tsx";

type BatchActionBarProps = {
  selectedCount: number;
  onClear: () => void;
  children: ReactNode;
};

export function BatchActionBar({ selectedCount, onClear, children }: BatchActionBarProps) {
  const { isMobile, state } = useSidebar();

  if (selectedCount === 0) {
    return null;
  }

  const insetStyle: CSSProperties = {
    left: isMobile
      ? "0.75rem"
      : `calc(var(${state === "collapsed" ? "--sidebar-width-icon" : "--sidebar-width"}) + 0.75rem)`,
    right: "0.75rem",
  };

  return (
    <div className="pointer-events-none fixed bottom-5 z-50 flex justify-center" style={insetStyle}>
      <div className="pointer-events-auto flex min-h-9 max-w-full flex-wrap items-center gap-2 rounded-lg bg-popover px-2 py-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
        <span className="text-sm whitespace-nowrap text-muted-foreground">
          {selectedCount} selected
        </span>
        <Separator orientation="vertical" className="h-4" />
        <div className="flex flex-wrap items-center gap-1">{children}</div>
        <Separator orientation="vertical" className="h-4" />
        <Button type="button" variant="ghost" size="sm" onClick={onClear}>
          <X data-icon="inline-start" />
          Clear
        </Button>
      </div>
    </div>
  );
}
