import { useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Loader2,
  PanelBottom,
  PanelRight,
  Pencil,
  RefreshCw,
  Square,
  Wrench,
} from "lucide-react";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Button } from "@aperture-browser/ui/components/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuTrigger,
} from "@aperture-browser/ui/components/context-menu";
import { InputGroup, InputGroupInput } from "@aperture-browser/ui/components/input-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@aperture-browser/ui/components/tooltip";
import type { UseBrowserControlResult } from "../hooks/use-browser-control.ts";
import { useFork } from "../effect.tsx";
import type { ResolvedSessionFeatures } from "../features.ts";
import { BrowserTabStrip } from "./browser-tab-strip.tsx";
import { BrowserMenus } from "./browser-toolbar-menus.tsx";
import type { DevToolsDock } from "./browser-devtools-pane.tsx";
import type { CollaborationRole } from "@aperture-browser/live-session";
import { CollaborationPresence } from "./collaboration-presence.tsx";

interface BrowserToolbarProps {
  control: UseBrowserControlResult;
  leading?: ReactNode;
  features: ResolvedSessionFeatures;
  collaborationRole: CollaborationRole;
  cdpUrl: string | null;
  shareUrls: { editor: string; viewer: string } | null;
  localCursorEnabled: boolean;
  onLocalCursorChange: (enabled: boolean) => void;
  paintingEnabled: boolean;
  onPaintingEnabledChange: (enabled: boolean) => void;
  devToolsOpen: boolean;
  devToolsTargetIds: ReadonlySet<string>;
  devToolsDock: DevToolsDock;
  onDevToolsOpenChange: (open: boolean) => void;
  onDevToolsDockChange: (dock: DevToolsDock) => void;
  onSessionDetails?: () => void;
}

export function BrowserToolbar({
  control,
  leading,
  features,
  collaborationRole,
  cdpUrl,
  shareUrls,
  localCursorEnabled,
  onLocalCursorChange,
  paintingEnabled,
  onPaintingEnabledChange,
  devToolsOpen,
  devToolsTargetIds,
  devToolsDock,
  onDevToolsOpenChange,
  onDevToolsDockChange,
  onSessionDetails,
}: BrowserToolbarProps) {
  const [urlDraft, setUrlDraft] = useState<string | null>(null);

  const displayUrl = control.activeTarget?.url ?? "";
  const busy = control.phase === "connecting";
  const connected = control.phase === "connected";
  const browserMutationEnabled = connected && collaborationRole !== "viewer";
  const drawingAvailable =
    connected && control.collaboration.phase === "connected" && Boolean(control.activeTargetId);
  const loading = control.activeTarget?.loading ?? false;
  // Peers that do not report history availability keep both buttons enabled.
  const canGoBack = control.activeTarget?.canGoBack ?? true;
  const canGoForward = control.activeTarget?.canGoForward ?? true;
  const runningRecordings = control.recordings.filter(
    (recording) => recording.status === "starting" || recording.status === "running",
  );
  const hasRunningRecordings = runningRecordings.length > 0;
  const recordingTargetIds = new Set(runningRecordings.map((recording) => recording.targetId));
  const [recordingNow, setRecordingNow] = useState(Date.now());

  useFork(
    () =>
      hasRunningRecordings
        ? Effect.repeat(
            Effect.sync(() => setRecordingNow(Date.now())),
            Schedule.spaced(1000),
          )
        : undefined,
    [hasRunningRecordings],
  );

  function handleNavigate(value: string) {
    const nextUrl = value.trim();
    if (!nextUrl) {
      return;
    }
    control.navigate(normalizeUrl(nextUrl));
    setUrlDraft(null);
  }

  return (
    <div className="aperture:flex aperture:min-w-0 aperture:flex-col aperture:bg-background">
      {leading || features.tabs || features.presence ? (
        <div
          data-workbench-titlebar
          className="aperture:flex aperture:min-w-0 aperture:shrink-0 aperture:items-stretch aperture:border-b aperture:bg-muted/35"
        >
          {leading}
          {features.tabs ? (
            <BrowserTabStrip
              targets={control.targets}
              activeTargetId={control.activeTargetId}
              recordingTargetIds={recordingTargetIds}
              devToolsTargetIds={devToolsTargetIds}
              disabled={!connected}
              mutationDisabled={!browserMutationEnabled}
              onActivate={control.activateTarget}
              onCreate={() => control.createTarget("about:blank")}
              onDuplicate={control.duplicateTarget}
              onClose={control.closeTarget}
              onReload={control.reload}
              onReorder={control.reorderTargets}
              loadThumbnail={control.loadTargetThumbnail}
            />
          ) : (
            <div className="aperture:min-w-0 aperture:flex-1" />
          )}
          {features.presence ? (
            <CollaborationPresence collaboration={control.collaboration} />
          ) : null}
        </div>
      ) : null}
      {features.navigation ||
      features.addressBar ||
      features.drawing ||
      features.devTools ||
      features.menus ? (
        <div className="aperture:flex aperture:h-9 aperture:items-center aperture:gap-1 aperture:px-1.5">
          {features.navigation ? (
            <div className="aperture:flex aperture:shrink-0 aperture:items-center aperture:gap-0.5">
              <ToolbarButton
                label="Back"
                disabled={!browserMutationEnabled || !canGoBack}
                onClick={() => control.historyBack()}
              >
                <ArrowLeft />
              </ToolbarButton>
              <ToolbarButton
                label="Forward"
                disabled={!browserMutationEnabled || !canGoForward}
                onClick={() => control.historyForward()}
              >
                <ArrowRight />
              </ToolbarButton>
              <ToolbarButton
                label={loading ? "Stop loading" : "Reload"}
                disabled={!browserMutationEnabled}
                onClick={() => {
                  if (loading) {
                    control.stopLoading();
                  } else if (control.activeTargetId) {
                    control.reload(control.activeTargetId);
                  }
                }}
              >
                {loading ? <Square /> : <RefreshCw />}
              </ToolbarButton>
            </div>
          ) : null}
          {features.addressBar ? (
            <InputGroup className="aperture:h-7 aperture:border-transparent aperture:bg-transparent aperture:transition-colors aperture:hover:border-input/50 aperture:hover:bg-muted/35 aperture:has-[[data-slot=input-group-control]:focus-visible]:border-input/70 aperture:has-[[data-slot=input-group-control]:focus-visible]:bg-background aperture:has-[[data-slot=input-group-control]:focus-visible]:ring-2 aperture:has-[[data-slot=input-group-control]:focus-visible]:ring-ring/20 aperture:dark:hover:bg-input/20">
              <InputGroupInput
                value={urlDraft ?? displayUrl}
                onChange={(event) => setUrlDraft(event.target.value)}
                onFocus={(event) => event.currentTarget.select()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    handleNavigate(event.currentTarget.value);
                  }
                }}
                placeholder="URL"
                className="aperture:h-7 aperture:px-2 aperture:font-mono aperture:text-xs aperture:text-muted-foreground aperture:transition-colors aperture:focus-visible:text-foreground"
                disabled={!browserMutationEnabled}
              />
            </InputGroup>
          ) : (
            <div className="aperture:min-w-0 aperture:flex-1" />
          )}
          {busy ? (
            <Loader2 className="aperture:size-4 aperture:shrink-0 aperture:animate-spin aperture:text-muted-foreground" />
          ) : null}
          {features.drawing ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant={paintingEnabled ? "secondary" : "ghost"}
                    size="icon-sm"
                    className="aperture:shrink-0"
                    disabled={!paintingEnabled && !drawingAvailable}
                    aria-label={paintingEnabled ? "Stop drawing" : "Draw on this tab"}
                    aria-pressed={paintingEnabled}
                    onClick={() => onPaintingEnabledChange(!paintingEnabled)}
                  />
                }
              >
                <Pencil />
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {paintingEnabled ? "Stop drawing" : "Draw on this tab"}
              </TooltipContent>
            </Tooltip>
          ) : null}
          {features.devTools ? (
            <DevToolsButton
              open={devToolsOpen}
              dock={devToolsDock}
              available={
                collaborationRole === "owner" &&
                connected &&
                Boolean(cdpUrl && control.activeTargetId)
              }
              onOpenChange={onDevToolsOpenChange}
              onDockChange={onDevToolsDockChange}
            />
          ) : null}
          {features.menus ? (
            <BrowserMenus
              control={control}
              cdpUrl={cdpUrl}
              shareUrls={shareUrls}
              busy={busy}
              connected={connected}
              localCursorEnabled={localCursorEnabled}
              onLocalCursorChange={onLocalCursorChange}
              onReconnect={() => control.reconnect()}
              onSessionDetails={onSessionDetails}
              now={recordingNow}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DevToolsButton({
  open,
  dock,
  available,
  onOpenChange,
  onDockChange,
}: {
  open: boolean;
  dock: DevToolsDock;
  available: boolean;
  onOpenChange: (open: boolean) => void;
  onDockChange: (dock: DevToolsDock) => void;
}) {
  const label = open ? "Close DevTools" : "Open DevTools";

  return (
    <ContextMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <ContextMenuTrigger
              render={
                <Button
                  type="button"
                  variant={open ? "secondary" : "ghost"}
                  size="icon-sm"
                  disabled={!open && !available}
                  aria-label={label}
                  aria-pressed={open}
                  onClick={() => onOpenChange(!open)}
                />
              }
            />
          }
        >
          <Wrench />
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}. Right-click to choose dock side.</TooltipContent>
      </Tooltip>
      <ContextMenuContent>
        <ContextMenuGroup>
          <ContextMenuLabel>Dock side</ContextMenuLabel>
          <ContextMenuRadioGroup
            value={dock}
            onValueChange={(value) => {
              switch (value) {
                case "bottom":
                  onDockChange("bottom");
                  break;
                case "right":
                  onDockChange("right");
                  break;
              }
            }}
          >
            <ContextMenuRadioItem value="bottom">
              <PanelBottom />
              Bottom
            </ContextMenuRadioItem>
            <ContextMenuRadioItem value="right">
              <PanelRight />
              Right
            </ContextMenuRadioItem>
          </ContextMenuRadioGroup>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function ToolbarButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (isLocalHost(trimmed)) {
    return `http://${trimmed}`;
  }
  if (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ||
    /^(about|chrome|devtools|data|file):/i.test(trimmed)
  ) {
    return trimmed;
  }
  if (isLikelyHost(trimmed)) {
    return `https://${trimmed}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

function isLocalHost(value: string): boolean {
  return (
    /^localhost(?::\d+)?(?:[/?#].*)?$/i.test(value) ||
    /^127(?:\.\d{1,3}){3}(?::\d+)?(?:[/?#].*)?$/.test(value) ||
    /^[a-z0-9-]+:\d+(?:[/?#].*)?$/i.test(value)
  );
}

function isLikelyHost(value: string): boolean {
  return !/\s/.test(value) && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/:?#].*)?$/i.test(value);
}
