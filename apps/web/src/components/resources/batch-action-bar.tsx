import type { CSSProperties, ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@aperture-browser/ui/components/button";
import { Separator } from "@aperture-browser/ui/components/separator";
import { useSidebar } from "@aperture-browser/ui/components/sidebar";

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
    <div
      className="aperture:pointer-events-none aperture:fixed aperture:bottom-5 aperture:z-50 aperture:flex aperture:justify-center"
      style={insetStyle}
    >
      <div className="aperture:pointer-events-auto aperture:flex aperture:min-h-9 aperture:max-w-full aperture:flex-wrap aperture:items-center aperture:gap-2 aperture:rounded-lg aperture:bg-popover aperture:px-2 aperture:py-1 aperture:text-popover-foreground aperture:shadow-md aperture:ring-1 aperture:ring-foreground/10">
        <span className="aperture:text-sm aperture:whitespace-nowrap aperture:text-muted-foreground">
          {selectedCount} selected
        </span>
        <Separator orientation="vertical" className="aperture:h-4" />
        <div className="aperture:flex aperture:flex-wrap aperture:items-center aperture:gap-1">
          {children}
        </div>
        <Separator orientation="vertical" className="aperture:h-4" />
        <Button type="button" variant="ghost" size="sm" onClick={onClear}>
          <X data-icon="inline-start" />
          Clear
        </Button>
      </div>
    </div>
  );
}
