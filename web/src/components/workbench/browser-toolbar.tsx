import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Circle,
  Gauge,
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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import { InputGroup, InputGroupInput } from "#/components/ui/input-group.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "#/components/ui/tooltip.tsx";
import { VIEWPORT_PRESETS } from "#/lib/control/viewport.ts";
import type { UseBrowserControlResult } from "#/hooks/use-browser-control.ts";
import { BrowserTabStrip } from "#/components/workbench/browser-tab-strip.tsx";

type BrowserToolbarProps = {
  control: UseBrowserControlResult;
  performanceOverlayEnabled: boolean;
  onPerformanceOverlayChange: (enabled: boolean) => void;
};

const STREAM_PRESETS = [
  {
    id: "low-data",
    label: "Low data",
    detail: "15 fps · 800 kbps",
    settings: { fps: 15, bitrateKbps: 800, keyframeInterval: 30 },
  },
  {
    id: "balanced",
    label: "Balanced",
    detail: "30 fps · 2500 kbps",
    settings: { fps: 30, bitrateKbps: 2500, keyframeInterval: 60 },
  },
  {
    id: "sharp",
    label: "Sharp",
    detail: "30 fps · 6000 kbps",
    settings: { fps: 30, bitrateKbps: 6000, keyframeInterval: 60 },
  },
  {
    id: "realtime",
    label: "Realtime",
    detail: "60 fps · 3500 kbps",
    settings: { fps: 60, bitrateKbps: 3500, keyframeInterval: 120 },
  },
] as const;

export function BrowserToolbar({
  control,
  performanceOverlayEnabled,
  onPerformanceOverlayChange,
}: BrowserToolbarProps) {
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
          <TooltipContent side="bottom">Sessions</TooltipContent>
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
            disabled={!connected}
          />
        </InputGroup>
        {busy ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" /> : null}
        <BrowserMenu
          control={control}
          busy={busy}
          connected={connected}
          performanceOverlayEnabled={performanceOverlayEnabled}
          onPerformanceOverlayChange={onPerformanceOverlayChange}
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
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function BrowserMenu({
  control,
  busy,
  connected,
  performanceOverlayEnabled,
  onPerformanceOverlayChange,
  onReconnect,
}: {
  control: UseBrowserControlResult;
  busy: boolean;
  connected: boolean;
  performanceOverlayEnabled: boolean;
  onPerformanceOverlayChange: (enabled: boolean) => void;
  onReconnect: () => void;
}) {
  const streamReady = control.mediaPhase === "live" && control.mediaPath === "webrtc-live";

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
          <DropdownMenuCheckboxItem
            disabled={!streamReady}
            checked={performanceOverlayEnabled}
            onCheckedChange={onPerformanceOverlayChange}
          >
            <Activity />
            Performance overlay
          </DropdownMenuCheckboxItem>
          <DropdownMenuItem
            disabled={!connected || control.recordingBusy || control.recordingActive}
            onClick={control.startRecording}
          >
            <Circle />
            Start recording
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!connected || control.recordingBusy || !control.recordingActive}
            onClick={control.stopRecording}
          >
            <Square />
            Stop recording
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
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={!streamReady}>
              <Gauge />
              Stream
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-56">
              <DropdownMenuLabel>Stream</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={activeStreamPresetId(control.mediaStreamSettings)}
                onValueChange={(value) => {
                  const preset = STREAM_PRESETS.find((item) => item.id === value);
                  if (preset) {
                    control.setWebRTCStreamSettings(preset.settings);
                  }
                }}
              >
                {STREAM_PRESETS.map((preset) => (
                  <DropdownMenuRadioItem key={preset.id} value={preset.id}>
                    <span className="flex min-w-0 flex-col">
                      <span>{preset.label}</span>
                      <span className="text-xs text-muted-foreground">{preset.detail}</span>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="flex items-center gap-2">
                <Activity className="size-3.5" />
                Metrics
              </DropdownMenuLabel>
              <StreamMetrics metrics={control.mediaMetrics} />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
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

function StreamMetrics({ metrics }: { metrics: UseBrowserControlResult["mediaMetrics"] }) {
  const rows = [
    ["Recv", formatKbps(metrics?.receivedBitrateKbps)],
    ["FPS", formatNumber(metrics?.decodedFps, 1)],
    ["Frame", formatFrameSize(metrics?.frameWidth, metrics?.frameHeight)],
    ["Drop", formatNumber(metrics?.framesDropped, 0)],
    ["Lost", formatNumber(metrics?.packetsLost, 0)],
    ["Jitter", formatMs(metrics?.jitterMs)],
    ["Buffer", formatMs(metrics?.jitterBufferDelayMs)],
    ["RTT", formatMs(metrics?.roundTripTimeMs)],
    ["Input", formatMs(metrics?.inputRttMs)],
    ["Codec", metrics?.codec?.replace(/^video\//, "") ?? "n/a"],
    ["Path", metrics?.candidatePair ?? "n/a"],
  ];

  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 px-2 py-1.5 text-xs">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <span className="text-muted-foreground">{label}</span>
          <span className="min-w-0 truncate text-right font-mono tabular-nums">{value}</span>
        </div>
      ))}
    </div>
  );
}

function activeStreamPresetId(settings: UseBrowserControlResult["mediaStreamSettings"]) {
  const preset = STREAM_PRESETS.find(
    (item) =>
      settings?.fps === item.settings.fps &&
      settings.bitrateKbps === item.settings.bitrateKbps &&
      settings.keyframeInterval === item.settings.keyframeInterval,
  );
  return preset?.id ?? "";
}

function formatKbps(value: number | null | undefined) {
  if (typeof value !== "number") {
    return "n/a";
  }
  return value >= 1000 ? `${(value / 1000).toFixed(1)} Mbps` : `${Math.round(value)} kbps`;
}

function formatNumber(value: number | null | undefined, fractionDigits: number) {
  return typeof value === "number" ? value.toFixed(fractionDigits) : "n/a";
}

function formatMs(value: number | null | undefined) {
  return typeof value === "number" ? `${Math.round(value)} ms` : "n/a";
}

function formatFrameSize(width: number | null | undefined, height: number | null | undefined) {
  return typeof width === "number" && typeof height === "number"
    ? `${Math.round(width)}x${Math.round(height)}`
    : "n/a";
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
