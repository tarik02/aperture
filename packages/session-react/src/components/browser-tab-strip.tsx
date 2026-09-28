import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as Effect from "effect/Effect";
import { Globe2, Plus, Wrench, X } from "lucide-react";
import { Button } from "@aperture-browser/ui/components/button";
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
import { usePortalContainer } from "@aperture-browser/ui/portal";
import { copyTextWithToast } from "../clipboard.ts";
import { useEffectCallback, useFork } from "../effect.tsx";
import { cn } from "@aperture-browser/ui/utils";
import type { LiveSessionTarget } from "@aperture-browser/live-session";
import type { UseBrowserControlResult } from "../hooks/use-browser-control.ts";

const BROWSER_TAB_DRAG_KIND = "browser-tab";
const TAB_PREVIEW_WIDTH = 320;
const TAB_PREVIEW_CAPTURE_WIDTH = 640;
const TAB_PREVIEW_MARGIN = 16;
const TAB_PREVIEW_GAP = 8;

type LoadThumbnail = UseBrowserControlResult["loadTargetThumbnail"];

interface TabPreviewState {
  targetId: string;
  top: number;
  left: number;
}

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
  const [preview, setPreview] = useState<TabPreviewState | null>(null);

  if (targets.length === 0) {
    return (
      <div className="flex h-8 min-w-0 flex-1 items-center gap-2 px-2 text-xs text-muted-foreground">
        <span>No tabs</span>
        <NewTabButton disabled={disabled || mutationDisabled} onCreate={onCreate} />
      </div>
    );
  }

  const previewTarget = targets.find((target) => target.id === preview?.targetId) ?? null;

  return (
    <>
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
                onPreviewEnter={(targetId, element) => {
                  const rect = element.getBoundingClientRect();
                  const width = Math.min(
                    TAB_PREVIEW_WIDTH,
                    window.innerWidth - TAB_PREVIEW_MARGIN * 2,
                  );
                  setPreview({
                    targetId,
                    top: rect.bottom + TAB_PREVIEW_GAP,
                    left: Math.max(
                      TAB_PREVIEW_MARGIN,
                      Math.min(rect.left, window.innerWidth - width - TAB_PREVIEW_MARGIN),
                    ),
                  });
                }}
                onPreviewLeave={(targetId) => {
                  setPreview((current) => (current?.targetId === targetId ? null : current));
                }}
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
      {preview && previewTarget && loadThumbnail ? (
        <TabPreviewPanel
          key={previewTarget.id}
          target={previewTarget}
          active={previewTarget.id === activeTargetId}
          loadThumbnail={loadThumbnail}
          top={preview.top}
          left={preview.left}
        />
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
  onPreviewEnter,
  onPreviewLeave,
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
  onPreviewEnter: (targetId: string, element: HTMLElement) => void;
  onPreviewLeave: (targetId: string) => void;
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
            onPointerEnter={(event) => onPreviewEnter(target.id, event.currentTarget)}
            onPointerLeave={() => onPreviewLeave(target.id)}
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

function capturePresentedThumbnail(): Effect.Effect<Blob, Error> {
  return Effect.tryPromise({
    try: async () => {
      const video = document.querySelector<HTMLVideoElement>("video[data-viewport-width]");
      if (
        !video ||
        video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
        video.videoWidth <= 0
      ) {
        throw new Error("presented browser frame is unavailable");
      }
      const viewportWidth = Number(video.dataset.viewportWidth);
      const viewportHeight = Number(video.dataset.viewportHeight);
      const contentHeight =
        viewportWidth > 0 && viewportHeight > 0
          ? Math.min(
              video.videoHeight,
              Math.round((viewportHeight * video.videoWidth) / viewportWidth),
            )
          : video.videoHeight;
      const width = Math.min(TAB_PREVIEW_CAPTURE_WIDTH, video.videoWidth);
      const height = Math.max(1, Math.round((contentHeight * width) / video.videoWidth));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("browser frame canvas is unavailable");
      }
      context.drawImage(video, 0, 0, video.videoWidth, contentHeight, 0, 0, width, height);
      return await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("browser frame encoding failed"))),
          "image/jpeg",
          0.7,
        );
      });
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error("browser frame capture failed")),
  });
}

function TabPreviewPanel({
  target,
  active,
  loadThumbnail,
  top,
  left,
}: {
  target: LiveSessionTarget;
  active: boolean;
  loadThumbnail: NonNullable<LoadThumbnail>;
  top: number;
  left: number;
}) {
  const portalContainer = usePortalContainer();
  const [src, setSrc] = useState<string | null>(null);

  useFork(
    () =>
      Effect.gen(function* () {
        const thumbnail = active ? capturePresentedThumbnail() : loadThumbnail(target.id);
        const blob = yield* thumbnail;
        const objectUrl = URL.createObjectURL(blob);
        yield* Effect.addFinalizer(() => Effect.sync(() => URL.revokeObjectURL(objectUrl)));
        setSrc(objectUrl);
        return yield* Effect.never;
      }).pipe(
        Effect.catch(() => Effect.void),
        Effect.scoped,
      ),
    [active, loadThumbnail, target.id],
  );

  const container = portalContainer ?? (typeof document === "undefined" ? null : document.body);
  if (container === null) {
    return null;
  }

  return createPortal(
    <div
      data-browser-tab-preview
      style={{ top, left }}
      className="pointer-events-none fixed z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-lg bg-popover p-2 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10"
    >
      <div className="aspect-video w-full overflow-hidden rounded-md bg-muted">
        {src ? <img src={src} alt="" className="size-full object-cover object-top" /> : null}
      </div>
      <span className="truncate text-xs font-medium">
        {target.title || simplifyUrl(target.url)}
      </span>
      <span className="truncate font-mono text-xs text-muted-foreground">
        {target.url || "about:blank"}
      </span>
    </div>,
    container,
  );
}
