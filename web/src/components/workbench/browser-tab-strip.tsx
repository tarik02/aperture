import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { useEffect, useRef, useState } from "react";
import { Globe2, Plus, X } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { ScrollArea } from "#/components/ui/scroll-area.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "#/components/ui/tooltip.tsx";
import { cn } from "#/lib/utils.ts";
import type { ControlTarget } from "#/lib/control/messages.ts";

const BROWSER_TAB_DRAG_KIND = "browser-tab";

type BrowserTabStripProps = {
  targets: ControlTarget[];
  activeTargetId: string | null;
  disabled?: boolean;
  onActivate: (targetId: string) => void;
  onCreate: () => void;
  onClose: (targetId: string) => void;
  onReorder: (
    sourceTargetId: string,
    destinationTargetId: string,
    placement: "before" | "after",
  ) => void;
};

type BrowserTabDragData = {
  kind: typeof BROWSER_TAB_DRAG_KIND;
  targetId: string;
};

type DropPlacement = "before" | "after";

export function BrowserTabStrip({
  targets,
  activeTargetId,
  disabled,
  onActivate,
  onCreate,
  onClose,
  onReorder,
}: BrowserTabStripProps) {
  if (targets.length === 0) {
    return (
      <div className="flex h-8 min-w-0 flex-1 items-center gap-2 px-2 text-xs text-muted-foreground">
        <span>No tabs</span>
        <NewTabButton disabled={disabled} onCreate={onCreate} />
      </div>
    );
  }

  return (
    <ScrollArea scrollbars="horizontal" className="h-8 min-w-0 flex-1">
      <div className="flex min-w-max items-end gap-0.5 px-1 pt-1">
        {targets.map((target) => {
          const active = target.id === activeTargetId;
          return (
            <BrowserTab
              key={target.id}
              target={target}
              active={active}
              disabled={disabled}
              onActivate={onActivate}
              onClose={onClose}
              onReorder={onReorder}
            />
          );
        })}
        <NewTabButton disabled={disabled} onCreate={onCreate} />
      </div>
    </ScrollArea>
  );
}

function BrowserTab({
  target,
  active,
  disabled,
  onActivate,
  onClose,
  onReorder,
}: {
  target: ControlTarget;
  active: boolean;
  disabled?: boolean;
  onActivate: (targetId: string) => void;
  onClose: (targetId: string) => void;
  onReorder: (
    sourceTargetId: string,
    destinationTargetId: string,
    placement: DropPlacement,
  ) => void;
}) {
  const tabRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dropPlacement, setDropPlacement] = useState<DropPlacement | null>(null);
  const label = simplifyUrl(target.url);

  useEffect(() => {
    const element = tabRef.current;
    if (!element) {
      return;
    }

    return combine(
      draggable({
        element,
        getInitialData: () => ({ kind: BROWSER_TAB_DRAG_KIND, targetId: target.id }),
        onDragStart: () => setDragging(true),
        onDrop: () => setDragging(false),
      }),
      dropTargetForElements({
        element,
        canDrop: ({ source }) => {
          return isBrowserTabDragData(source.data) && source.data.targetId !== target.id;
        },
        getData: () => ({ kind: BROWSER_TAB_DRAG_KIND, targetId: target.id }),
        onDrag: ({ location, self }) => {
          setDropPlacement(dropPlacementFromClientX(self.element, location.current.input.clientX));
        },
        onDragEnter: ({ location, self }) => {
          setDropPlacement(dropPlacementFromClientX(self.element, location.current.input.clientX));
        },
        onDragLeave: () => setDropPlacement(null),
        onDrop: ({ source, self, location }) => {
          setDropPlacement(null);
          if (!isBrowserTabDragData(source.data)) {
            return;
          }
          onReorder(
            source.data.targetId,
            target.id,
            dropPlacementFromClientX(self.element, location.current.input.clientX),
          );
        },
      }),
    );
  }, [onReorder, target.id]);

  return (
    <div
      ref={tabRef}
      data-browser-tab
      className={cn(
        "group relative flex h-7 w-52 max-w-[38vw] min-w-28 cursor-grab select-none items-center gap-1.5 rounded-t-lg border border-b-0 px-2 text-left text-xs transition-[background-color,border-color,color,opacity] active:cursor-grabbing",
        active
          ? "border-border bg-background text-foreground"
          : "border-transparent bg-muted/55 text-muted-foreground hover:bg-muted",
        dragging && "opacity-60",
      )}
      title={target.url || "about:blank"}
      onMouseDown={(event) => {
        if (event.button === 1) {
          event.preventDefault();
        }
      }}
      onAuxClick={(event) => {
        if (event.button === 1 && !disabled) {
          event.preventDefault();
          onClose(target.id);
        }
      }}
    >
      <span
        className={cn(
          "pointer-events-none absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary opacity-0",
          dropPlacement === "before" && "opacity-100",
        )}
      />
      <span
        className={cn(
          "pointer-events-none absolute inset-y-1 right-0 w-0.5 rounded-full bg-primary opacity-0",
          dropPlacement === "after" && "opacity-100",
        )}
      />
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        disabled={disabled}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        onClick={() => onActivate(target.id)}
      >
        <TabFavicon url={target.url} />
        <span className="min-w-0 truncate font-mono">{label}</span>
      </button>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="shrink-0 opacity-55 hover:opacity-100 group-hover:opacity-100"
              aria-label="Close tab"
              disabled={disabled}
              onClick={() => onClose(target.id)}
            />
          }
        >
          <X />
        </TooltipTrigger>
        <TooltipContent>Close tab</TooltipContent>
      </Tooltip>
    </div>
  );
}

function NewTabButton({ disabled, onCreate }: { disabled?: boolean; onCreate: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="mb-px shrink-0"
            aria-label="New tab"
            disabled={disabled}
            onClick={onCreate}
          />
        }
      >
        <Plus />
      </TooltipTrigger>
      <TooltipContent>New tab</TooltipContent>
    </Tooltip>
  );
}

function TabFavicon({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  const faviconUrl = resolveFaviconUrl(url);

  useEffect(() => {
    setFailed(false);
  }, [faviconUrl]);

  if (!faviconUrl || failed) {
    return <Globe2 className="size-4 shrink-0 text-muted-foreground" />;
  }

  return (
    <img src={faviconUrl} alt="" className="size-4 shrink-0" onError={() => setFailed(true)} />
  );
}

function resolveFaviconUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return null;
  }
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

function isBrowserTabDragData(data: Record<string, unknown>): data is BrowserTabDragData {
  return data.kind === BROWSER_TAB_DRAG_KIND && typeof data.targetId === "string";
}

function dropPlacementFromClientX(element: Element, clientX: number): DropPlacement {
  const rect = element.getBoundingClientRect();
  return clientX < rect.left + rect.width / 2 ? "before" : "after";
}
