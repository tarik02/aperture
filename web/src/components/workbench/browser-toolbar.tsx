import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowRight,
  Loader2,
  Maximize2,
  MoreVertical,
  Monitor,
  PanelLeftIcon,
  MousePointer2,
  RefreshCw,
  RotateCcw,
  Square,
} from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import { InputGroup, InputGroupInput } from "#/components/ui/input-group.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "#/components/ui/tooltip.tsx";
import { VIEWPORT_PRESETS } from "#/lib/control/viewport.ts";
import type { UseBrowserControlResult } from "#/hooks/use-browser-control.ts";
import { BrowserTabStrip } from "#/components/workbench/browser-tab-strip.tsx";

type BrowserToolbarProps = {
  control: UseBrowserControlResult;
};

export function BrowserToolbar({ control }: BrowserToolbarProps) {
  const [urlDraft, setUrlDraft] = useState<string | null>(null);

  const displayUrl = control.activeTarget?.url ?? "";
  const busy = control.phase === "connecting";
  const connected = control.phase === "connected";
  const loading = control.activeTarget?.loading ?? false;

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
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-full aspect-square shrink-0 rounded-none"
                aria-label="Back to sessions"
                render={<Link to="/sessions" />}
              />
            }
          >
            <PanelLeftIcon />
          </TooltipTrigger>
          <TooltipContent>Sessions</TooltipContent>
        </Tooltip>
        <BrowserTabStrip
          targets={control.targets}
          activeTargetId={control.activeTargetId}
          disabled={!connected}
          onActivate={control.activateTarget}
          onCreate={() => control.createTarget("about:blank")}
          onClose={control.closeTarget}
          onReorder={control.reorderTargets}
        />
      </div>
      <div className="flex h-9 items-center gap-1 px-1.5">
        <div className="flex shrink-0 items-center gap-0.5">
          <ToolbarButton label="Back" disabled={!connected} onClick={() => control.historyBack()}>
            <ArrowLeft />
          </ToolbarButton>
          <ToolbarButton
            label="Forward"
            disabled={!connected}
            onClick={() => control.historyForward()}
          >
            <ArrowRight />
          </ToolbarButton>
          <ToolbarButton
            label={loading ? "Stop loading" : "Reload"}
            disabled={!connected}
            onClick={() => {
              if (loading) {
                control.stopLoading();
              } else {
                control.reload();
              }
            }}
          >
            {loading ? <Square /> : <RefreshCw />}
          </ToolbarButton>
        </div>
        <InputGroup>
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
            className="font-mono text-xs"
            disabled={!connected}
          />
        </InputGroup>
        {busy ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" /> : null}
        <BrowserMenu
          control={control}
          busy={busy}
          connected={connected}
          onReconnect={() => control.reconnect()}
        />
      </div>
    </div>
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
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function BrowserMenu({
  control,
  busy,
  connected,
  onReconnect,
}: {
  control: UseBrowserControlResult;
  busy: boolean;
  connected: boolean;
  onReconnect: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button type="button" variant="ghost" size="icon-sm" aria-label="Browser menu" />}
      >
        <MoreVertical />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuGroup>
          <DropdownMenuItem disabled={busy} onClick={onReconnect}>
            <RotateCcw />
            Reconnect
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!connected}
            onClick={() => control.setCaptured(!control.captured)}
          >
            <MousePointer2 />
            {control.captured ? "Release input" : "Capture input"}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Viewport</DropdownMenuLabel>
          <DropdownMenuItem
            disabled={!connected || !control.browserViewportSize}
            onClick={() => control.setViewportToBrowserSize()}
          >
            <Maximize2 />
            Set to browser size
          </DropdownMenuItem>
          <DropdownMenuCheckboxItem
            disabled={!connected || !control.browserViewportSize}
            checked={control.viewportAutoSync}
            onCheckedChange={control.setViewportAutoSync}
          >
            <Monitor />
            Auto sync browser size
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup
            value={control.viewport.id}
            onValueChange={(value) => {
              const preset = VIEWPORT_PRESETS.find((item) => item.id === value);
              if (preset) {
                control.setViewport(preset);
              }
            }}
          >
            {VIEWPORT_PRESETS.map((preset) => (
              <DropdownMenuRadioItem key={preset.id} value={preset.id} disabled={!connected}>
                <Monitor />
                {preset.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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
