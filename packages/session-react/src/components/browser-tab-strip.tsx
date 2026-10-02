import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { useEffect, useRef, useState } from "react";
import * as Effect from "effect/Effect";
import { Globe2, Plus, Wrench, X } from "lucide-react";
import { Button } from "@aperture-browser/ui/components/button";
import {
  createHoverCardHandle,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  type HoverCardHandle,
} from "@aperture-browser/ui/components/hover-card";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@aperture-browser/ui/components/context-menu";
import { ScrollArea } from "@aperture-browser/ui/components/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@aperture-browser/ui/components/tooltip";
import { copyTextWithToast } from "../clipboard.ts";
import { useEffectCallback, useFork } from "../effect.tsx";
import { cn } from "@aperture-browser/ui/utils";
import type { LiveSessionTarget } from "@aperture-browser/live-session";
import type { UseBrowserControlResult } from "../hooks/use-browser-control.ts";

const BROWSER_TAB_DRAG_KIND = "browser-tab";

type LoadThumbnail = UseBrowserControlResult["loadTargetThumbnail"];

interface BrowserTabStripProps {
  targets: readonly LiveSessionTarget[];
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
  loadThumbnail?: LoadThumbnail;
}

interface BrowserTabDragData extends Record<string, unknown> {
  kind: typeof BROWSER_TAB_DRAG_KIND;
  targetId: string;
}

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
  loadThumbnail = null,
}: BrowserTabStripProps) {
  const [previewHandle] = useState(() => createHoverCardHandle<string>());

  if (targets.length === 0) {
    return (
      <div className="aperture:flex aperture:h-8 aperture:min-w-0 aperture:flex-1 aperture:items-center aperture:gap-2 aperture:px-2 aperture:text-xs aperture:text-muted-foreground">
        <span>No tabs</span>
        <NewTabButton disabled={disabled || mutationDisabled} onCreate={onCreate} />
      </div>
    );
  }

  return (
    <>
      <ScrollArea scrollbars="horizontal" className="aperture:h-8 aperture:min-w-0 aperture:flex-1">
        <div className="aperture:flex aperture:min-w-max aperture:items-end aperture:gap-0.5 aperture:px-1 aperture:pt-1">
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
                previewHandle={loadThumbnail ? previewHandle : null}
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
      {loadThumbnail ? (
        <HoverCard handle={previewHandle}>
          {({ payload }) => {
            const target = targets.find((current) => current.id === payload);
            return target ? (
              <TabPreview key={target.id} target={target} loadThumbnail={loadThumbnail} />
            ) : null;
          }}
        </HoverCard>
      ) : null}
    </>
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
  previewHandle,
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
  previewHandle: HoverCardHandle<string> | null;
  closeOtherTargetIds: string[];
  closeRightTargetIds: string[];
}) {
  const tabRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dropPlacement, setDropPlacement] = useState<DropPlacement | null>(null);
  const label = simplifyUrl(target.url);
  const copyUrl = useEffectCallback((url: string) => copyTextWithToast(url), []);

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

  const tab = (
    <div
      ref={tabRef}
      data-browser-tab
      className={cn(
        "aperture:group aperture:relative aperture:flex aperture:h-7 aperture:w-52 aperture:max-w-[38vw] aperture:min-w-28 aperture:cursor-grab aperture:select-none aperture:items-center aperture:gap-1.5 aperture:rounded-t-lg aperture:border aperture:border-b-0 aperture:px-2 aperture:text-left aperture:text-xs aperture:transition-[background-color,border-color,color,opacity] aperture:active:cursor-grabbing",
        active
          ? "aperture:border-border aperture:bg-background aperture:text-foreground"
          : "aperture:border-transparent aperture:bg-muted/55 aperture:text-muted-foreground aperture:hover:bg-muted",
        dragging && "aperture:opacity-60",
      )}
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
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          previewHandle ? (
            <HoverCardTrigger
              handle={previewHandle}
              payload={target.id}
              delay={0}
              closeDelay={0}
              render={tab}
            />
          ) : (
            tab
          )
        }
      >
        <span
          className={cn(
            "aperture:pointer-events-none aperture:absolute aperture:inset-y-1 aperture:left-0 aperture:w-0.5 aperture:rounded-full aperture:bg-primary aperture:opacity-0",
            dropPlacement === "before" && "aperture:opacity-100",
          )}
        />
        <span
          className={cn(
            "aperture:pointer-events-none aperture:absolute aperture:inset-y-1 aperture:right-0 aperture:w-0.5 aperture:rounded-full aperture:bg-primary aperture:opacity-0",
            dropPlacement === "after" && "aperture:opacity-100",
          )}
        />
        <button
          type="button"
          aria-current={active ? "page" : undefined}
          disabled={disabled}
          className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:items-center aperture:gap-1.5 aperture:text-left"
          onClick={() => onActivate(target.id)}
        >
          <TabFavicon url={target.url} />
          {devToolsOpen ? (
            <>
              <Wrench
                aria-hidden
                className="aperture:size-3.5 aperture:shrink-0 aperture:text-muted-foreground"
              />
              <span className="aperture:sr-only">DevTools open</span>
            </>
          ) : null}
          {recording ? (
            <>
              <span
                aria-hidden
                className="aperture:size-2 aperture:shrink-0 aperture:rounded-full aperture:bg-destructive"
              />
              <span className="aperture:sr-only">Recording</span>
            </>
          ) : null}
          <span className="aperture:min-w-0 aperture:truncate aperture:font-mono">{label}</span>
        </button>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="aperture:shrink-0 aperture:opacity-55 aperture:hover:opacity-100 aperture:group-hover:opacity-100"
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
      <ContextMenuContent className="aperture:min-w-48">
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
          <ContextMenuItem onClick={() => copyUrl(target.url || "about:blank")}>
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
            className="aperture:mb-px aperture:shrink-0"
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
    return <Globe2 className="aperture:size-4 aperture:shrink-0 aperture:text-muted-foreground" />;
  }

  return (
    <img
      src={faviconUrl}
      alt=""
      className="aperture:size-4 aperture:shrink-0"
      onError={() => setFailed(true)}
    />
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

function TabPreview({
  target,
  loadThumbnail,
}: {
  target: LiveSessionTarget;
  loadThumbnail: NonNullable<LoadThumbnail>;
}) {
  return (
    <HoverCardContent
      data-browser-tab-preview
      align="start"
      sideOffset={8}
      collisionPadding={16}
      className="aperture:pointer-events-none aperture:flex aperture:w-80 aperture:max-w-[calc(100vw-2rem)] aperture:flex-col aperture:gap-2 aperture:p-2"
    >
      <TabThumbnail targetId={target.id} loadThumbnail={loadThumbnail} />
      <span className="aperture:truncate aperture:text-xs aperture:font-medium">
        {target.title || simplifyUrl(target.url)}
      </span>
      <span className="aperture:truncate aperture:font-mono aperture:text-xs aperture:text-muted-foreground">
        {target.url || "about:blank"}
      </span>
    </HoverCardContent>
  );
}

// Lives inside the popup, which unmounts on close, so every opening loads a fresh thumbnail.
function TabThumbnail({
  targetId,
  loadThumbnail,
}: {
  targetId: string;
  loadThumbnail: NonNullable<LoadThumbnail>;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useFork(
    () =>
      Effect.gen(function* () {
        const blob = yield* loadThumbnail(targetId);
        const objectUrl = URL.createObjectURL(blob);
        yield* Effect.addFinalizer(() => Effect.sync(() => URL.revokeObjectURL(objectUrl)));
        setSrc(objectUrl);
        return yield* Effect.never;
      }).pipe(
        Effect.catch(() => Effect.void),
        Effect.scoped,
      ),
    [loadThumbnail, targetId],
  );

  return (
    <div className="aperture:aspect-video aperture:w-full aperture:overflow-hidden aperture:rounded-md aperture:bg-muted">
      {src ? (
        <img
          src={src}
          alt=""
          className="aperture:size-full aperture:object-cover aperture:object-top"
        />
      ) : null}
    </div>
  );
}
