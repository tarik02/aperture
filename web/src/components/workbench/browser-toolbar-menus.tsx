import { Fragment, useEffect, useId, useState } from "react";
import {
  Circle,
  Copy,
  Download,
  Gauge,
  Info,
  Lock,
  LockOpen,
  Maximize2,
  MoreVertical,
  Monitor,
  MousePointer2,
  RotateCcw,
  Share2,
  X,
} from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { Field, FieldGroup, FieldLabel } from "#/components/ui/field.tsx";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "#/components/ui/tooltip.tsx";
import {
  createViewportPreset,
  formatViewportScale,
  VIEWPORT_DEVICE_SCALE_FACTORS,
  VIEWPORT_PRESETS,
} from "#/lib/control/viewport.ts";
import type { UseBrowserControlResult } from "#/hooks/use-browser-control.ts";
import { copyText } from "#/components/resources/copy-button.tsx";
import { toast } from "sonner";

const STREAM_PRESETS = [
  {
    id: "low",
    label: "Low",
    detail: "20 fps · max 800 kbps",
    settings: { fps: 20, bitrateKbps: 800 },
  },
  {
    id: "balanced",
    label: "Balanced",
    detail: "30 fps · max 3000 kbps",
    settings: { fps: 30, bitrateKbps: 3000 },
  },
  {
    id: "high",
    label: "High",
    detail: "60 fps · max 20000 kbps",
    settings: { fps: 60, bitrateKbps: 20_000 },
  },
] as const;

const STREAM_LIMITS = {
  fps: { min: 1, max: 120 },
  bitrateKbps: { min: 100, max: 50_000 },
} as const;

const VIEWPORT_LIMITS = {
  width: { min: 1, max: 16_384 },
  height: { min: 1, max: 16_384 },
  deviceScaleFactor: { min: 0.25, max: 4 },
} as const;

export function BrowserMenus({
  control,
  cdpUrl,
  shareUrls,
  busy,
  connected,
  localCursorEnabled,
  onLocalCursorChange,
  onReconnect,
  onSessionDetails,
  now,
}: {
  control: UseBrowserControlResult;
  cdpUrl: string | null;
  shareUrls: { editor: string; viewer: string } | null;
  busy: boolean;
  connected: boolean;
  localCursorEnabled: boolean;
  onLocalCursorChange: (enabled: boolean) => void;
  onReconnect: () => void;
  onSessionDetails?: () => void;
  now: number;
}) {
  const runningRecordings = control.recordings.filter(
    (recording) => recording.status === "starting" || recording.status === "running",
  );
  const recordingActive = runningRecordings.length > 0;

  return (
    <>
      <div className="shrink-0 sm:hidden">
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger
              render={
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant={recordingActive ? "destructive" : "ghost"}
                      size="icon-sm"
                      aria-label={
                        recordingActive ? "Browser menu, recording active" : "Browser menu"
                      }
                    />
                  }
                />
              }
            >
              {recordingActive ? <Circle fill="currentColor" /> : <MoreVertical />}
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {recordingActive ? "Browser menu, recording active" : "Browser menu"}
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-72">
            <RestMenuItems
              control={control}
              cdpUrl={cdpUrl}
              shareUrls={shareUrls}
              onSessionDetails={onSessionDetails}
            />
            {control.recordingSupported ? (
              <>
                <DropdownMenuSeparator />
                <RecordingMenuItems
                  control={control}
                  connected={connected && control.collaboration.role === "owner"}
                  runningRecordings={runningRecordings}
                  now={now}
                />
              </>
            ) : null}
            <DropdownMenuSeparator />
            <ViewportStreamMenuItems
              control={control}
              connected={connected && control.collaboration.role !== "viewer"}
              localCursorEnabled={localCursorEnabled}
              onLocalCursorChange={onLocalCursorChange}
              busy={busy}
              onReconnect={onReconnect}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="hidden shrink-0 items-center gap-0.5 sm:flex">
        {control.recordingSupported ? (
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <DropdownMenuTrigger
                    render={
                      <Button
                        type="button"
                        variant={recordingActive ? "destructive" : "ghost"}
                        size="icon-sm"
                        aria-label={recordingActive ? "Recording in progress" : "Recording"}
                      />
                    }
                  />
                }
              >
                <Circle fill={recordingActive ? "currentColor" : "none"} />
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {recordingActive ? "Recording in progress" : "Recording"}
              </TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-72">
              <RecordingMenuItems
                control={control}
                connected={connected && control.collaboration.role === "owner"}
                runningRecordings={runningRecordings}
                now={now}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger
              render={
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Viewport and stream"
                    />
                  }
                />
              }
            >
              <Monitor />
            </TooltipTrigger>
            <TooltipContent side="bottom">Viewport and stream</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-56">
            <ViewportStreamMenuItems
              control={control}
              connected={connected && control.collaboration.role !== "viewer"}
              localCursorEnabled={localCursorEnabled}
              onLocalCursorChange={onLocalCursorChange}
              busy={busy}
              onReconnect={onReconnect}
            />
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger
              render={
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="More browser actions"
                    />
                  }
                />
              }
            >
              <MoreVertical />
            </TooltipTrigger>
            <TooltipContent side="bottom">More browser actions</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-48">
            <RestMenuItems
              control={control}
              cdpUrl={cdpUrl}
              shareUrls={shareUrls}
              onSessionDetails={onSessionDetails}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}

function RestMenuItems({
  control,
  cdpUrl,
  shareUrls,
  onSessionDetails,
}: {
  control: UseBrowserControlResult;
  cdpUrl: string | null;
  shareUrls: { editor: string; viewer: string } | null;
  onSessionDetails?: () => void;
}) {
  return (
    <DropdownMenuGroup>
      <InputControlMenuItem control={control} />
      {onSessionDetails ? (
        <DropdownMenuItem onClick={onSessionDetails}>
          <Info />
          Session details
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem
        disabled={!cdpUrl}
        onClick={() => {
          if (!cdpUrl) {
            return;
          }
          void copyText(cdpUrl).then(
            () => toast.success("CDP URL copied"),
            () => toast.error("Copy failed"),
          );
        }}
      >
        <Copy />
        Copy CDP URL
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={!shareUrls}
        onClick={() => {
          if (!shareUrls) {
            return;
          }
          void copyText(shareUrls.editor).then(
            () => toast.success("Editor URL copied"),
            () => toast.error("Copy failed"),
          );
        }}
      >
        <Share2 />
        Copy editor URL
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={!shareUrls}
        onClick={() => {
          if (!shareUrls) {
            return;
          }
          void copyText(shareUrls.viewer).then(
            () => toast.success("Viewer URL copied"),
            () => toast.error("Copy failed"),
          );
        }}
      >
        <Share2 />
        Copy viewer URL
      </DropdownMenuItem>
    </DropdownMenuGroup>
  );
}

function InputControlMenuItem({ control }: { control: UseBrowserControlResult }) {
  const collaboration = control.collaboration;
  const targetId = control.activeTargetId;
  const explicitControlClaimed =
    collaboration.holderClientId !== null && collaboration.leaseMode === "explicit";
  const localControlClaimed = collaboration.hasControl && collaboration.leaseMode === "explicit";
  let label = "Control offline";
  let disabled = collaboration.phase !== "connected" || !targetId;
  let action = () => undefined;

  if (collaboration.role === "viewer") {
    label = "View only";
    disabled = true;
  } else if (collaboration.hasControl && collaboration.leaseMode === "explicit") {
    label = "Release control";
    action = () => {
      collaboration.release();
    };
  } else if (collaboration.hasControl) {
    label = "Claim control";
    action = () => {
      if (targetId) {
        collaboration.claim(targetId, "explicit");
      }
    };
  } else {
    const holder = collaboration.participants.find(
      (participant) => participant.clientId === collaboration.holderClientId,
    );
    const canPreempt = collaboration.role === "owner" && holder?.role === "editor";
    const controlBlocked = explicitControlClaimed && !canPreempt;
    label = controlBlocked ? "Control in use" : "Claim control";
    disabled = disabled || controlBlocked;
    action = () => {
      if (targetId) {
        collaboration.claim(targetId, "explicit");
      }
    };
  }

  return (
    <DropdownMenuItem disabled={disabled} onClick={action}>
      {localControlClaimed ? <Lock /> : <LockOpen />}
      {label}
    </DropdownMenuItem>
  );
}

function RecordingMenuItems({
  control,
  connected,
  runningRecordings,
  now,
}: {
  control: UseBrowserControlResult;
  connected: boolean;
  runningRecordings: UseBrowserControlResult["recordings"];
  now: number;
}) {
  const recordingAvailable = connected && control.collaboration.role === "owner";
  const canStart = recordingAvailable && Boolean(control.activeTargetId) && !control.recordingBusy;
  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuLabel>Recording</DropdownMenuLabel>
        <DropdownMenuItem disabled={!canStart} onClick={() => control.startRecording("tab")}>
          <Circle />
          <span className="flex min-w-0 flex-col">
            <span>Record this tab</span>
            <span className="text-xs text-muted-foreground">Stay pinned to this target</span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canStart} onClick={() => control.startRecording("viewer")}>
          <Monitor />
          <span className="flex min-w-0 flex-col">
            <span>Record this viewer</span>
            <span className="text-xs text-muted-foreground">
              {recordingAvailable ? "Follow tab switches" : "Owner connection required"}
            </span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuGroup>
      {runningRecordings.map((recording) => {
        const target = control.targets.find((candidate) => candidate.id === recording.targetId);
        return (
          <Fragment key={recording.recordingId}>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>
                <span className="flex min-w-0 items-center justify-between gap-2">
                  <span className="truncate">
                    {recording.mode === "viewer" ? "Viewer" : "Tab"}:{" "}
                    {target?.title || recording.targetId.slice(0, 8)}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {formatElapsed(recording.startedAt, now)}
                  </span>
                </span>
              </DropdownMenuLabel>
              <DropdownMenuItem
                disabled={control.recordingBusy}
                onClick={() => control.stopRecording(recording.recordingId)}
              >
                <Download />
                Stop and download
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={control.recordingBusy}
                onClick={() => control.cancelRecording(recording.recordingId)}
              >
                <X />
                Cancel without download
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </Fragment>
        );
      })}
    </>
  );
}

function ViewportStreamMenuItems({
  control,
  connected,
  localCursorEnabled,
  onLocalCursorChange,
  busy,
  onReconnect,
}: {
  control: UseBrowserControlResult;
  connected: boolean;
  localCursorEnabled: boolean;
  onLocalCursorChange: (enabled: boolean) => void;
  busy: boolean;
  onReconnect: () => void;
}) {
  return (
    <DropdownMenuGroup>
      <ViewportMenu control={control} connected={connected} />
      {control.mediaVideoProfiles.length > 0 ? (
        <StreamMenu
          control={control}
          qualityUpdatesEnabled={control.collaboration.role !== "viewer"}
        />
      ) : null}
      {control.remoteCursorSupported ? (
        <DropdownMenuCheckboxItem
          disabled={!connected || control.collaboration.role === "viewer"}
          checked={control.remoteCursorEnabled}
          onCheckedChange={control.setRemoteCursorEnabled}
        >
          <MousePointer2 />
          Remote cursor
        </DropdownMenuCheckboxItem>
      ) : null}
      <DropdownMenuCheckboxItem checked={localCursorEnabled} onCheckedChange={onLocalCursorChange}>
        <MousePointer2 />
        Local cursor
      </DropdownMenuCheckboxItem>
      <DropdownMenuItem disabled={busy} onClick={onReconnect}>
        <RotateCcw />
        Reconnect
      </DropdownMenuItem>
    </DropdownMenuGroup>
  );
}

function StreamMenu({
  control,
  qualityUpdatesEnabled,
}: {
  control: UseBrowserControlResult;
  qualityUpdatesEnabled: boolean;
}) {
  const settings = control.mediaStreamSettings;
  const source =
    control.mediaPath === "websocket-live"
      ? "jpeg"
      : qualityUpdatesEnabled
        ? settings?.profile
        : "webrtc";
  const disabled = control.mediaSwitching || control.phase !== "connected";
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Gauge />
        Stream
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Source</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={source}
            onValueChange={(value) => {
              if (value === "jpeg") {
                control.selectMediaStream({ kind: "jpeg" });
                return;
              }
              if (value === "webrtc") {
                control.selectMediaStream({ kind: "webrtc-retry" });
                return;
              }
              const profile = control.mediaVideoProfiles.find(
                (candidate) => candidate.id === value,
              );
              if (profile && settings) {
                control.selectMediaStream({
                  kind: "webrtc",
                  quality: { ...settings, profile: profile.id },
                });
              }
            }}
          >
            {!qualityUpdatesEnabled ? (
              <DropdownMenuRadioItem value="webrtc" disabled={disabled}>
                <span className="flex min-w-0 flex-col">
                  <span>WebRTC</span>
                  <span className="text-xs text-muted-foreground">Live video</span>
                </span>
              </DropdownMenuRadioItem>
            ) : null}
            {qualityUpdatesEnabled
              ? control.mediaVideoProfiles.map((profile) => (
                  <DropdownMenuRadioItem
                    key={profile.id}
                    value={profile.id}
                    disabled={disabled || !settings}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span>{profile.label}</span>
                      <span className="text-xs text-muted-foreground">
                        {profile.codec} · WebRTC
                      </span>
                    </span>
                  </DropdownMenuRadioItem>
                ))
              : null}
            <DropdownMenuRadioItem value="jpeg" disabled={disabled}>
              <span className="flex min-w-0 flex-col">
                <span>JPEG</span>
                <span className="text-xs text-muted-foreground">WebSocket raster stream</span>
              </span>
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          {qualityUpdatesEnabled && control.mediaPath === "webrtc-live" && settings ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Quality</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={activeStreamPresetId(settings)}
                onValueChange={(value) => {
                  const preset = STREAM_PRESETS.find((item) => item.id === value);
                  if (preset) {
                    control.setWebRTCStreamSettings({ ...settings, ...preset.settings });
                  }
                }}
              >
                {STREAM_PRESETS.map((preset) => (
                  <DropdownMenuRadioItem key={preset.id} value={preset.id} disabled={disabled}>
                    <span className="flex min-w-0 flex-col">
                      <span>{preset.label}</span>
                      <span className="text-xs text-muted-foreground">{preset.detail}</span>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <CustomStreamSettings
                settings={settings}
                disabled={disabled}
                onApply={control.setWebRTCStreamSettings}
              />
            </>
          ) : null}
        </DropdownMenuGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
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
  disabled,
  onApply,
}: {
  settings: NonNullable<UseBrowserControlResult["mediaStreamSettings"]>;
  disabled: boolean;
  onApply: UseBrowserControlResult["setWebRTCStreamSettings"];
}) {
  const [fps, setFps] = useState(String(settings.fps));
  const [bitrateKbps, setBitrateKbps] = useState(String(settings.bitrateKbps));

  useEffect(() => {
    setFps(String(settings.fps));
    setBitrateKbps(String(settings.bitrateKbps));
  }, [settings]);

  const nextSettings = parseStreamSettings({ fps, bitrateKbps });
  const unchanged =
    settings.fps === nextSettings?.fps && settings.bitrateKbps === nextSettings?.bitrateKbps;

  return (
    <FieldGroup
      className="gap-2 px-2 py-1.5"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <DropdownMenuLabel className="px-0">Custom</DropdownMenuLabel>
      <div className="grid grid-cols-2 gap-2">
        <StreamNumberField label="FPS" value={fps} onChange={setFps} />
        <StreamNumberField label="Max Kbps" value={bitrateKbps} onChange={setBitrateKbps} />
      </div>
      <Button
        type="button"
        size="sm"
        className="h-7 w-full"
        disabled={disabled || !nextSettings || unchanged}
        onClick={() => {
          if (nextSettings) {
            onApply({ ...settings, ...nextSettings });
          }
        }}
      >
        Apply
      </Button>
    </FieldGroup>
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
  const id = useId();
  return (
    <Field className="gap-1">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="text"
        inputMode="numeric"
        value={value}
        onChange={(event) => onChange(digitsOnly(event.currentTarget.value))}
        onFocus={(event) => event.currentTarget.select()}
        className="h-7"
      />
    </Field>
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
  const id = useId();
  return (
    <Field className="gap-1">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(event) => onChange(decimalNumber(event.currentTarget.value))}
        onFocus={(event) => event.currentTarget.select()}
        className="h-7"
      />
    </Field>
  );
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

function parseStreamSettings({ fps, bitrateKbps }: { fps: string; bitrateKbps: string }) {
  if (!fps || !bitrateKbps) {
    return null;
  }
  return {
    fps: clampInteger(Number(fps), STREAM_LIMITS.fps.min, STREAM_LIMITS.fps.max),
    bitrateKbps: clampInteger(
      Number(bitrateKbps),
      STREAM_LIMITS.bitrateKbps.min,
      STREAM_LIMITS.bitrateKbps.max,
    ),
  };
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
      settings.fps === item.settings.fps && settings.bitrateKbps === item.settings.bitrateKbps,
  );
  return preset?.id ?? "";
}

function formatElapsed(startedAt: string, now: number): string {
  const elapsed = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
