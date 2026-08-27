import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { useEffect, useRef, useState } from "react";
import { Globe2, Plus, Wrench, X } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "#/components/ui/context-menu.tsx";
import { ScrollArea } from "#/components/ui/scroll-area.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "#/components/ui/tooltip.tsx";
import { copyText } from "#/components/resources/copy-button.tsx";
import { cn } from "#/lib/utils.ts";
import type { LiveSessionTarget } from "#/lib/control/live-session-protocol.ts";
import { toast } from "sonner";

const BROWSER_TAB_DRAG_KIND = "browser-tab";

type BrowserTabStripProps = {
  targets: LiveSessionTarget[];
  activeTargetId: string | null;
  recordingTargetIds: ReadonlySet<string>;
  devToolsTargetIds: ReadonlySet<string>;
  disabled?: boolean;
  mutationDisabled?: boolean;
  onActivate: (targetId: string) => void;
  onCreate: () => void;
  onDuplicate: (target: LiveSessionTarget) => void;
  onClose: (targetId: string) => void;
  onReload: (targetId: string) => void;
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
  recordingTargetIds,
  devToolsTargetIds,
  disabled,
  mutationDisabled,
  onActivate,
  onCreate,
  onDuplicate,
  onClose,
  onReload,
  onReorder,
}: BrowserTabStripProps) {
  if (targets.length === 0) {
    return (
      <div className="flex h-8 min-w-0 flex-1 items-center gap-2 px-2 text-xs text-muted-foreground">
        <span>No tabs</span>
        <NewTabButton disabled={disabled || mutationDisabled} onCreate={onCreate} />
      </div>
    );
  }

  return (
    <ScrollArea scrollbars="horizontal" className="h-8 min-w-0 flex-1">
      <div className="flex min-w-max items-end gap-0.5 px-1 pt-1">
        {targets.map((target, index) => {
          const active = target.id === activeTargetId;
          return (
            <BrowserTab
              key={target.id}
              target={target}
              active={active}
              recording={recordingTargetIds.has(target.id)}
              devToolsOpen={devToolsTargetIds.has(target.id)}
              disabled={disabled}
              mutationDisabled={mutationDisabled}
              onActivate={onActivate}
              onDuplicate={onDuplicate}
              onClose={onClose}
              onReload={onReload}
              onReorder={onReorder}
              closeOtherTargetIds={targets
                .filter((current) => current.id !== target.id)
                .map((current) => current.id)}
              closeRightTargetIds={targets.slice(index + 1).map((current) => current.id)}
            />
          );
        })}
        <NewTabButton disabled={disabled || mutationDisabled} onCreate={onCreate} />
      </div>
    </ScrollArea>
  );
}

function BrowserTab({
  target,
  active,
  recording,
  devToolsOpen,
  disabled,
  mutationDisabled,
  onActivate,
  onDuplicate,
  onClose,
  onReload,
  onReorder,
  closeOtherTargetIds,
  closeRightTargetIds,
}: {
  target: LiveSessionTarget;
  active: boolean;
  recording: boolean;
  devToolsOpen: boolean;
  disabled?: boolean;
  mutationDisabled?: boolean;
  onActivate: (targetId: string) => void;
  onDuplicate: (target: LiveSessionTarget) => void;
  onClose: (targetId: string) => void;
  onReload: (targetId: string) => void;
  onReorder: (
    sourceTargetId: string,
    destinationTargetId: string,
    placement: DropPlacement,
  ) => void;
  closeOtherTargetIds: string[];
  closeRightTargetIds: string[];
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
    <ContextMenu>
      <ContextMenuTrigger
        render={
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
              if (event.button === 1 && !disabled && !mutationDisabled) {
                event.preventDefault();
                onClose(target.id);
              }
            }}
          />
        }
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
          {devToolsOpen ? (
            <>
              <Wrench aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="sr-only">DevTools open</span>
            </>
          ) : null}
          {recording ? (
            <>
              <span aria-hidden className="size-2 shrink-0 rounded-full bg-destructive" />
              <span className="sr-only">Recording</span>
            </>
          ) : null}
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
                disabled={disabled || mutationDisabled}
                onClick={() => onClose(target.id)}
              />
            }
          >
            <X />
          </TooltipTrigger>
          <TooltipContent side="bottom">Close tab</TooltipContent>
        </Tooltip>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-48">
        <ContextMenuGroup>
          <ContextMenuItem
            disabled={disabled || mutationDisabled}
            onClick={() => onReload(target.id)}
          >
            Reload
          </ContextMenuItem>
          <ContextMenuItem
            disabled={disabled || mutationDisabled}
            onClick={() => onDuplicate(target)}
          >
            Duplicate
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              void copyText(target.url || "about:blank").catch(() => {
                toast.error("Copy failed");
              });
            }}
          >
            Copy URL
          </ContextMenuItem>
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuItem
            disabled={disabled || mutationDisabled}
            onClick={() => onClose(target.id)}
          >
            Close
          </ContextMenuItem>
          <ContextMenuItem
            disabled={disabled || mutationDisabled || closeOtherTargetIds.length === 0}
            onClick={() => {
              for (const targetId of closeOtherTargetIds) {
                onClose(targetId);
              }
            }}
          >
            Close other tabs
          </ContextMenuItem>
          <ContextMenuItem
            disabled={disabled || mutationDisabled || closeRightTargetIds.length === 0}
            onClick={() => {
              for (const targetId of closeRightTargetIds) {
                onClose(targetId);
              }
            }}
          >
            Close tabs to the right
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
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
      <TooltipContent side="bottom">New tab</TooltipContent>
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
