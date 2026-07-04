import { X } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { ScrollArea, ScrollBar } from "#/components/ui/scroll-area.tsx";
import { cn } from "#/lib/utils.ts";
import type { ControlTarget } from "#/lib/control/messages.ts";

type BrowserTabStripProps = {
  targets: ControlTarget[];
  activeTargetId: string | null;
  onActivate: (targetId: string) => void;
  onClose: (targetId: string) => void;
};

export function BrowserTabStrip({
  targets,
  activeTargetId,
  onActivate,
  onClose,
}: BrowserTabStripProps) {
  if (targets.length === 0) {
    return <div className="px-2 py-1 text-xs text-muted-foreground">No tabs</div>;
  }

  return (
    <ScrollArea className="w-full">
      <div className="flex min-w-max items-stretch gap-1 px-1 py-1">
        {targets.map((target) => {
          const active = target.id === activeTargetId;
          const title = target.title.trim() || "Untitled";
          return (
            <button
              key={target.id}
              type="button"
              onClick={() => onActivate(target.id)}
              className={cn(
                "group flex max-w-56 min-w-32 items-center gap-1 rounded-md border px-2 py-1 text-left text-xs transition-colors",
                active
                  ? "border-primary/40 bg-primary/10 text-foreground"
                  : "border-transparent bg-muted/40 text-muted-foreground hover:bg-muted",
              )}
            >
              <span className="truncate font-medium">{title}</span>
              <span className="truncate text-[10px] opacity-70">{simplifyUrl(target.url)}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="ml-auto shrink-0 opacity-60 group-hover:opacity-100"
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(target.id);
                }}
              >
                <X />
              </Button>
            </button>
          );
        })}
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  );
}

function simplifyUrl(url: string): string {
  if (!url || url === "about:blank") {
    return "about:blank";
  }
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
}
