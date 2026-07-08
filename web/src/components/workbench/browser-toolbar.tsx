import { useEffect, useState } from "react";
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
import { Input } from "#/components/ui/input.tsx";
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
import {
  createViewportPreset,
  formatViewportScale,
  VIEWPORT_DEVICE_SCALE_FACTORS,
  VIEWPORT_PRESETS,
} from "#/lib/control/viewport.ts";
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

const STREAM_LIMITS = {
  fps: { min: 1, max: 120 },
  bitrateKbps: { min: 1, max: 50_000 },
  keyframeInterval: { min: 1, max: 600 },
} as const;

const VIEWPORT_LIMITS = {
  width: { min: 1, max: 16_384 },
  height: { min: 1, max: 16_384 },
  deviceScaleFactor: { min: 0.25, max: 4 },
} as const;

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
                render={<Link to="/-/sessions" />}
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
  const showStreamMenu = control.mediaPath === "webrtc-live";

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
            disabled={!showStreamMenu}
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
          <ViewportMenu control={control} connected={connected} />
          {showStreamMenu ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Gauge />
                Stream
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-64">
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
                <CustomStreamSettings
                  settings={control.mediaStreamSettings}
                  onApply={control.setWebRTCStreamSettings}
                />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : null}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ViewportMenu({
  control,
  connected,
}: {
  control: UseBrowserControlResult;
  connected: boolean;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Monitor />
        Viewport
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-64">
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
          value={activeViewportPresetId(control.viewport)}
          onValueChange={(value) => {
            const preset = VIEWPORT_PRESETS.find((item) => item.id === value);
            if (preset) {
              control.setViewport(
                createViewportPreset(
                  preset.width,
                  preset.height,
                  control.viewport.deviceScaleFactor,
                ),
              );
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
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Scale</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={activeViewportScaleId(control.viewport.deviceScaleFactor)}
          onValueChange={(value) => {
            const nextScale = VIEWPORT_DEVICE_SCALE_FACTORS.find(
              (item) => formatViewportScale(item) === value,
            );
            if (nextScale) {
              control.setViewport(
                createViewportPreset(control.viewport.width, control.viewport.height, nextScale),
              );
            }
          }}
        >
          {VIEWPORT_DEVICE_SCALE_FACTORS.map((deviceScaleFactor) => (
            <DropdownMenuRadioItem
              key={deviceScaleFactor}
              value={formatViewportScale(deviceScaleFactor)}
              disabled={!connected}
            >
              <Monitor />
              {formatViewportScale(deviceScaleFactor)}x
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <CustomViewportSettings
          viewport={control.viewport}
          connected={connected}
          onApply={control.setViewport}
        />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function CustomViewportSettings({
  viewport,
  connected,
  onApply,
}: {
  viewport: UseBrowserControlResult["viewport"];
  connected: boolean;
  onApply: UseBrowserControlResult["setViewport"];
}) {
  const [width, setWidth] = useState(String(viewport.width));
  const [height, setHeight] = useState(String(viewport.height));
  const [deviceScaleFactor, setDeviceScaleFactor] = useState(
    formatViewportScale(viewport.deviceScaleFactor),
  );

  useEffect(() => {
    setWidth(String(viewport.width));
    setHeight(String(viewport.height));
    setDeviceScaleFactor(formatViewportScale(viewport.deviceScaleFactor));
  }, [viewport]);

  const nextViewport = parseViewportSettings({ width, height, deviceScaleFactor });
  const unchanged = nextViewport
    ? viewport.width === nextViewport.width &&
      viewport.height === nextViewport.height &&
      viewport.deviceScaleFactor === nextViewport.deviceScaleFactor
    : false;

  return (
    <div
      className="grid gap-2 px-2 py-1.5"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <DropdownMenuLabel className="px-0">Custom</DropdownMenuLabel>
      <div className="grid grid-cols-3 gap-2">
        <StreamNumberField label="Width" value={width} onChange={setWidth} />
        <StreamNumberField label="Height" value={height} onChange={setHeight} />
        <ViewportScaleField
          label="Scale"
          value={deviceScaleFactor}
          onChange={setDeviceScaleFactor}
        />
      </div>
      <Button
        type="button"
        size="sm"
        className="h-7"
        disabled={!connected || !nextViewport || unchanged}
        onClick={() => {
          if (nextViewport) {
            onApply(nextViewport);
          }
        }}
      >
        Apply
      </Button>
    </div>
  );
}

function CustomStreamSettings({
  settings,
  onApply,
}: {
  settings: UseBrowserControlResult["mediaStreamSettings"];
  onApply: UseBrowserControlResult["setWebRTCStreamSettings"];
}) {
  const [fps, setFps] = useState(String(settings?.fps ?? 60));
  const [bitrateKbps, setBitrateKbps] = useState(String(settings?.bitrateKbps ?? 6000));
  const [keyframeInterval, setKeyframeInterval] = useState(
    String(settings?.keyframeInterval ?? 120),
  );

  useEffect(() => {
    if (settings) {
      setFps(String(settings.fps));
      setBitrateKbps(String(settings.bitrateKbps));
      setKeyframeInterval(String(settings.keyframeInterval));
    }
  }, [settings]);

  const nextSettings = parseStreamSettings({ fps, bitrateKbps, keyframeInterval });
  const unchanged = settings
    ? settings.fps === nextSettings?.fps &&
      settings.bitrateKbps === nextSettings?.bitrateKbps &&
      settings.keyframeInterval === nextSettings?.keyframeInterval
    : false;

  return (
    <div
      className="grid gap-2 px-2 py-1.5"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <DropdownMenuLabel className="px-0">Custom</DropdownMenuLabel>
      <div className="grid grid-cols-3 gap-2">
        <StreamNumberField label="FPS" value={fps} onChange={setFps} />
        <StreamNumberField label="Kbps" value={bitrateKbps} onChange={setBitrateKbps} />
        <StreamNumberField label="Key" value={keyframeInterval} onChange={setKeyframeInterval} />
      </div>
      <Button
        type="button"
        size="sm"
        className="h-7"
        disabled={!nextSettings || unchanged}
        onClick={() => {
          if (nextSettings) {
            onApply(nextSettings);
          }
        }}
      >
        Apply
      </Button>
    </div>
  );
}

function StreamNumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1 text-xs text-muted-foreground">
      <span>{label}</span>
      <Input
        type="text"
        inputMode="numeric"
        value={value}
        onChange={(event) => onChange(digitsOnly(event.currentTarget.value))}
        onFocus={(event) => event.currentTarget.select()}
        className="h-7 rounded-md px-2 text-xs tabular-nums"
      />
    </label>
  );
}

function ViewportScaleField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1 text-xs text-muted-foreground">
      <span>{label}</span>
      <Input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(event) => onChange(decimalNumber(event.currentTarget.value))}
        onFocus={(event) => event.currentTarget.select()}
        className="h-7 rounded-md px-2 text-xs tabular-nums"
      />
    </label>
  );
}

function parseStreamSettings({
  fps,
  bitrateKbps,
  keyframeInterval,
}: {
  fps: string;
  bitrateKbps: string;
  keyframeInterval: string;
}) {
  if (!fps || !bitrateKbps || !keyframeInterval) {
    return null;
  }
  return {
    fps: clampInteger(Number(fps), STREAM_LIMITS.fps.min, STREAM_LIMITS.fps.max),
    bitrateKbps: clampInteger(
      Number(bitrateKbps),
      STREAM_LIMITS.bitrateKbps.min,
      STREAM_LIMITS.bitrateKbps.max,
    ),
    keyframeInterval: clampInteger(
      Number(keyframeInterval),
      STREAM_LIMITS.keyframeInterval.min,
      STREAM_LIMITS.keyframeInterval.max,
    ),
  };
}

function parseViewportSettings({
  width,
  height,
  deviceScaleFactor,
}: {
  width: string;
  height: string;
  deviceScaleFactor: string;
}) {
  if (!width || !height || !deviceScaleFactor) {
    return null;
  }
  const parsedWidth = Number(width);
  const parsedHeight = Number(height);
  const parsedScale = Number(deviceScaleFactor);
  if (
    !Number.isFinite(parsedWidth) ||
    !Number.isFinite(parsedHeight) ||
    !Number.isFinite(parsedScale)
  ) {
    return null;
  }
  const nextWidth = clampInteger(parsedWidth, VIEWPORT_LIMITS.width.min, VIEWPORT_LIMITS.width.max);
  const nextHeight = clampInteger(
    parsedHeight,
    VIEWPORT_LIMITS.height.min,
    VIEWPORT_LIMITS.height.max,
  );
  const maxScale = Math.min(
    VIEWPORT_LIMITS.deviceScaleFactor.max,
    VIEWPORT_LIMITS.width.max / nextWidth,
    VIEWPORT_LIMITS.height.max / nextHeight,
  );
  const nextScale = clampDecimal(parsedScale, VIEWPORT_LIMITS.deviceScaleFactor.min, maxScale);
  return createViewportPreset(nextWidth, nextHeight, nextScale);
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

function decimalNumber(value: string): string {
  const [integer = "", ...fraction] = value.replace(/[^\d.]/g, "").split(".");
  return fraction.length ? `${integer}.${fraction.join("")}` : integer;
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max);
}

function clampDecimal(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value * 100) / 100, min), max);
}

function activeViewportPresetId(viewport: UseBrowserControlResult["viewport"]) {
  const preset = VIEWPORT_PRESETS.find(
    (item) => viewport.width === item.width && viewport.height === item.height,
  );
  return preset?.id ?? "";
}

function activeViewportScaleId(deviceScaleFactor: number) {
  const preset = VIEWPORT_DEVICE_SCALE_FACTORS.find((item) => item === deviceScaleFactor);
  return preset ? formatViewportScale(preset) : "";
}

function activeStreamPresetId(settings: UseBrowserControlResult["mediaStreamSettings"]) {
  if (!settings) {
    return "";
  }
  const preset = STREAM_PRESETS.find(
    (item) =>
      settings.fps === item.settings.fps &&
      settings.bitrateKbps === item.settings.bitrateKbps &&
      settings.keyframeInterval === item.settings.keyframeInterval,
  );
  return preset?.id ?? "";
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
