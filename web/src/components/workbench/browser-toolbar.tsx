import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowRight,
  Loader2,
  PanelBottom,
  PanelLeftIcon,
  PanelRight,
  RefreshCw,
  Square,
  Wrench,
} from "lucide-react";
import { interval } from "rxjs";
import { Button } from "#/components/ui/button.tsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuTrigger,
} from "#/components/ui/context-menu.tsx";
import { InputGroup, InputGroupInput } from "#/components/ui/input-group.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "#/components/ui/tooltip.tsx";
import type { UseBrowserControlResult } from "#/hooks/use-browser-control.ts";
import { BrowserTabStrip } from "#/components/workbench/browser-tab-strip.tsx";
import { BrowserMenus } from "#/components/workbench/browser-toolbar-menus.tsx";
import type { DevToolsDock } from "#/components/workbench/browser-devtools-pane.tsx";
import type { CollaborationRole } from "#/hooks/use-collaboration-control.ts";

type BrowserToolbarProps = {
  control: UseBrowserControlResult;
  guestMode: boolean;
  collaborationRole: CollaborationRole;
  cdpUrl: string | null;
  shareUrls: { editor: string; viewer: string } | null;
  performanceOverlayEnabled: boolean;
  onPerformanceOverlayChange: (enabled: boolean) => void;
  localCursorEnabled: boolean;
  onLocalCursorChange: (enabled: boolean) => void;
  devToolsOpen: boolean;
  devToolsTargetIds: ReadonlySet<string>;
  devToolsDock: DevToolsDock;
  onDevToolsOpenChange: (open: boolean) => void;
  onDevToolsDockChange: (dock: DevToolsDock) => void;
  onSessionDetails?: () => void;
};

export function BrowserToolbar({
  control,
  guestMode,
  collaborationRole,
  cdpUrl,
  shareUrls,
  performanceOverlayEnabled,
  onPerformanceOverlayChange,
  localCursorEnabled,
  onLocalCursorChange,
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
  const loading = control.activeTarget?.loading ?? false;
  const runningRecordings = control.recordings.filter(
    (recording) => recording.status === "starting" || recording.status === "running",
  );
  const hasRunningRecordings = runningRecordings.length > 0;
  const recordingTargetIds = new Set(runningRecordings.map((recording) => recording.targetId));
  const [recordingNow, setRecordingNow] = useState(Date.now());

  useEffect(() => {
    if (!hasRunningRecordings) {
      return;
    }
    setRecordingNow(Date.now());
    const subscription = interval(1000).subscribe(() => setRecordingNow(Date.now()));
    return () => subscription.unsubscribe();
  }, [hasRunningRecordings]);

  function handleNavigate(value: string) {
    const nextUrl = value.trim();
    if (!nextUrl) {
      return;
    }
    control.navigate(normalizeUrl(nextUrl));
    setUrlDraft(null);
  }

  return (
    <div className="flex min-w-0 flex-col bg-background">
      <div
        data-workbench-titlebar
        className="flex min-w-0 shrink-0 items-stretch border-b bg-muted/35"
      >
        {!guestMode ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="h-full aspect-square shrink-0 rounded-none"
                  aria-label="Back to sessions"
                  render={<Link to="/-/sessions" />}
                />
              }
            >
              <PanelLeftIcon />
            </TooltipTrigger>
            <TooltipContent side="bottom">Sessions</TooltipContent>
          </Tooltip>
        ) : null}
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
        />
      </div>
      <div className="flex h-9 items-center gap-1 px-1.5">
        <div className="flex shrink-0 items-center gap-0.5">
          <ToolbarButton
            label="Back"
            disabled={!browserMutationEnabled}
            onClick={() => control.historyBack()}
          >
            <ArrowLeft />
          </ToolbarButton>
          <ToolbarButton
            label="Forward"
            disabled={!browserMutationEnabled}
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
        <InputGroup className="h-7 border-transparent bg-transparent transition-colors hover:border-input/50 hover:bg-muted/35 has-[[data-slot=input-group-control]:focus-visible]:border-input/70 has-[[data-slot=input-group-control]:focus-visible]:bg-background has-[[data-slot=input-group-control]:focus-visible]:ring-2 has-[[data-slot=input-group-control]:focus-visible]:ring-ring/20 dark:hover:bg-input/20">
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
            className="h-7 px-2 font-mono text-xs text-muted-foreground transition-colors focus-visible:text-foreground"
            disabled={!browserMutationEnabled}
          />
        </InputGroup>
        {busy ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" /> : null}
        <DevToolsButton
          open={devToolsOpen}
          dock={devToolsDock}
          available={
            collaborationRole === "owner" && connected && Boolean(cdpUrl && control.activeTargetId)
          }
          onOpenChange={onDevToolsOpenChange}
          onDockChange={onDevToolsDockChange}
        />
        <BrowserMenus
          control={control}
          cdpUrl={cdpUrl}
          shareUrls={shareUrls}
          busy={busy}
          connected={connected}
          performanceOverlayEnabled={performanceOverlayEnabled}
          onPerformanceOverlayChange={onPerformanceOverlayChange}
          localCursorEnabled={localCursorEnabled}
          onLocalCursorChange={onLocalCursorChange}
          onReconnect={() => control.reconnect()}
          onSessionDetails={onSessionDetails}
          now={recordingNow}
        />
      </div>
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
