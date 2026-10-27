import { Fragment, useEffect, useId, useState, type ReactNode } from "react";
import {
  Circle,
  Copy,
  Download,
  Gauge,
  Hand,
  Info,
  Lock,
  LockOpen,
  Maximize2,
  MoreVertical,
  PanelBottom,
  PanelRight,
  Pencil,
  Wrench,
  Monitor,
  MonitorPause,
  Eye,
  MousePointer2,
  RotateCcw,
  Share2,
  X,
} from "lucide-react";
import { Button } from "@aperture-browser/ui/components/button";
import { Field, FieldGroup, FieldLabel } from "@aperture-browser/ui/components/field";
import { Input } from "@aperture-browser/ui/components/input";
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
} from "@aperture-browser/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@aperture-browser/ui/components/tooltip";
import {
  createViewportPreset,
  formatViewportScale,
  VIEWPORT_DEVICE_SCALE_FACTORS,
  VIEWPORT_PRESETS,
} from "@aperture-browser/live-session";
import type { UseBrowserControlResult } from "../hooks/use-browser-control.ts";
import { copyTextWithToast } from "../clipboard.ts";
import { useEffectCallback } from "../effect.tsx";
import { toast } from "sonner";
import type { RecordingSettings } from "@aperture-browser/api-client";
import { useRecordingSettings } from "../hooks/use-recording-settings.ts";
import { RecordingSettingsMenuItems } from "./recording-settings-menu.tsx";
import type { DevToolsDock } from "./browser-devtools-pane.tsx";

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

export interface BrowserMenuDrawing {
  readonly enabled: boolean;
  readonly available: boolean;
  readonly onChange: (enabled: boolean) => void;
}

export interface BrowserMenuDevTools {
  readonly open: boolean;
  readonly dock: DevToolsDock;
  readonly available: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDockChange: (dock: DevToolsDock) => void;
}

/**
 * One menu for everything the toolbar does not show as a button: the embedder's own items
 * first, then control and tools, recording and viewport submenus, sharing, and the embedder's
 * closing items (such as deleting the session) last. Recording gets a toolbar button only while
 * one runs.
 */
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
  menuItems,
  shareMenuItems,
  menuFooterItems,
  drawing,
  devTools,
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
  menuItems?: ReactNode;
  shareMenuItems?: ReactNode;
  menuFooterItems?: ReactNode;
  drawing: BrowserMenuDrawing | null;
  devTools: BrowserMenuDevTools | null;
  now: number;
}) {
  const { settings, updateSettings } = useRecordingSettings();
  const runningRecordings = control.recordings.filter(
    (recording) => recording.status === "starting" || recording.status === "running",
  );
  const recordingActive = runningRecordings.length > 0;
  const viewportConnected = connected && control.collaboration.role !== "viewer";

  function startRecording(mode: "tab" | "viewer") {
    const { capture: _capture, burst, ...continuous } = settings;
    if (mode === "tab" && settings.capture === "bursts") {
      const { idle: _idle, ...bursts } = continuous;
      control.startRecording(mode, {
        ...bursts,
        capture: "bursts",
        ...(burst === undefined ? {} : { burst }),
      });
    } else {
      control.startRecording(mode, { ...continuous, capture: "continuous" });
    }
  }

  const recordingItems = (
    <RecordingMenuItems
      control={control}
      connected={connected}
      runningRecordings={runningRecordings}
      now={now}
      settings={settings}
      onSettingsChange={updateSettings}
      onStartRecording={startRecording}
    />
  );

  return (
    <div className="aperture:flex aperture:shrink-0 aperture:items-center aperture:gap-0.5">
      {recordingActive ? (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger
              render={
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="destructive"
                      size="icon-sm"
                      aria-label="Recording in progress"
                    />
                  }
                />
              }
            >
              <Circle fill="currentColor" />
            </TooltipTrigger>
            <TooltipContent side="bottom">Recording in progress</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="aperture:w-72">
            {recordingItems}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <ViewportPausedIndicator control={control} connected={viewportConnected} />
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="Browser menu" />
                }
              />
            }
          >
            <MoreVertical />
          </TooltipTrigger>
          <TooltipContent side="bottom">Browser menu</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="aperture:w-60">
          {menuItems ? (
            <>
              {menuItems}
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuGroup>
            {onSessionDetails ? (
              <DropdownMenuItem onClick={onSessionDetails}>
                <Info />
                Session details
              </DropdownMenuItem>
            ) : null}
            <InputControlMenuItem control={control} />
            {drawing ? (
              <DropdownMenuCheckboxItem
                checked={drawing.enabled}
                disabled={!drawing.enabled && !drawing.available}
                onCheckedChange={drawing.onChange}
              >
                <Pencil />
                Draw on this tab
              </DropdownMenuCheckboxItem>
            ) : null}
            {devTools ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger disabled={!devTools.open && !devTools.available}>
                  <Wrench />
                  Developer tools
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="aperture:w-44">
                  <DropdownMenuCheckboxItem
                    checked={devTools.open}
                    disabled={!devTools.open && !devTools.available}
                    onCheckedChange={devTools.onOpenChange}
                  >
                    Open DevTools
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Dock side</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={devTools.dock}
                      onValueChange={(value) => {
                        if (value === "bottom" || value === "right") {
                          devTools.onDockChange(value);
                        }
                      }}
                    >
                      <DropdownMenuRadioItem value="bottom">
                        <PanelBottom />
                        Bottom
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="right">
                        <PanelRight />
                        Right
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : null}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Circle
                  fill={recordingActive ? "currentColor" : "none"}
                  className={recordingActive ? "aperture:text-destructive" : undefined}
                />
                Recording
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="aperture:w-72">
                {recordingItems}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Monitor />
                Viewport and stream
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="aperture:w-56">
                <ViewportStreamMenuItems
                  control={control}
                  connected={viewportConnected}
                  localCursorEnabled={localCursorEnabled}
                  onLocalCursorChange={onLocalCursorChange}
                  busy={busy}
                  onReconnect={onReconnect}
                />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Share2 />
                Share and connect
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="aperture:w-56">
                {shareMenuItems}
                <ShareMenuItems cdpUrl={cdpUrl} shareUrls={shareUrls} />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuGroup>
          {menuFooterItems ? (
            <>
              <DropdownMenuSeparator />
              {menuFooterItems}
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function ShareMenuItems({
  cdpUrl,
  shareUrls,
}: {
  cdpUrl: string | null;
  shareUrls: { editor: string; viewer: string } | null;
}) {
  const copy = useEffectCallback(
    (value: string, copied: string) => copyTextWithToast(value, () => toast.success(copied)),
    [],
  );

  return (
    <DropdownMenuGroup>
      <DropdownMenuItem
        disabled={!shareUrls}
        onClick={() => shareUrls && copy(shareUrls.editor, "Editor link copied")}
      >
        <Copy />
        Copy editor link
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={!shareUrls}
        onClick={() => shareUrls && copy(shareUrls.viewer, "Viewer link copied")}
      >
        <Copy />
        Copy viewer link
      </DropdownMenuItem>
      <DropdownMenuItem disabled={!cdpUrl} onClick={() => cdpUrl && copy(cdpUrl, "CDP URL copied")}>
        <Copy />
        Copy CDP URL
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
  settings,
  onSettingsChange,
  onStartRecording,
}: {
  control: UseBrowserControlResult;
  connected: boolean;
  runningRecordings: UseBrowserControlResult["recordings"];
  now: number;
  settings: RecordingSettings;
  onSettingsChange: (settings: RecordingSettings) => void;
  onStartRecording: (mode: "tab" | "viewer") => void;
}) {
  const recordingAvailable = connected && control.canRecord;
  const canStart = recordingAvailable && Boolean(control.activeTargetId) && !control.recordingBusy;
  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuLabel>Recording</DropdownMenuLabel>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuItem disabled={!canStart} onClick={() => onStartRecording("tab")} />
            }
          >
            <Circle />
            Start recording
          </TooltipTrigger>
          <TooltipContent side="left">
            Uses the capture mode below. The full raw video downloads when you stop. When editing is
            enabled, an edited copy appears in session files.
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuItem disabled={!canStart} onClick={() => onStartRecording("viewer")} />
            }
          >
            <Monitor />
            {recordingAvailable ? (
              "Record this viewer"
            ) : (
              <span className="aperture:flex aperture:min-w-0 aperture:flex-col">
                <span>Record this viewer</span>
                <span className="aperture:text-xs aperture:text-muted-foreground">
                  Connect as an owner or editor
                </span>
              </span>
            )}
          </TooltipTrigger>
          <TooltipContent side="left">
            {recordingAvailable
              ? "Continuous capture following your tab switches. Quiet stretches, pace and click highlights use the settings below."
              : "Connect as an owner or editor to record."}
          </TooltipContent>
        </Tooltip>
      </DropdownMenuGroup>
      {runningRecordings.map((recording) => {
        const target = control.targets.find((candidate) => candidate.id === recording.targetId);
        return (
          <Fragment key={recording.recordingId}>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>
                <span className="aperture:flex aperture:min-w-0 aperture:items-center aperture:justify-between aperture:gap-2">
                  <span className="aperture:truncate">
                    {recording.mode === "viewer" ? "Viewer" : "Tab"}:{" "}
                    {target?.title || recording.targetId.slice(0, 8)}
                  </span>
                  <span className="aperture:shrink-0 aperture:tabular-nums">
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
      <RecordingSettingsMenuItems settings={settings} onChange={onSettingsChange} />
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
      <DropdownMenuCheckboxItem
        disabled={!connected || control.collaboration.role === "viewer"}
        checked={control.remoteCursorEnabled}
        onCheckedChange={control.setRemoteCursorEnabled}
      >
        <MousePointer2 />
        Remote cursor
      </DropdownMenuCheckboxItem>
      <DropdownMenuCheckboxItem
        disabled={!connected || !control.canRecord}
        checked={control.watchableAutomation}
        onCheckedChange={control.setWatchableAutomation}
      >
        <Eye />
        Watchable automation
      </DropdownMenuCheckboxItem>
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
      <DropdownMenuSubContent className="aperture:w-64">
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
                <span className="aperture:flex aperture:min-w-0 aperture:flex-col">
                  <span>WebRTC</span>
                  <span className="aperture:text-xs aperture:text-muted-foreground">
                    Live video
                  </span>
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
                    <span className="aperture:flex aperture:min-w-0 aperture:flex-col">
                      <span>{profile.label}</span>
                      <span className="aperture:text-xs aperture:text-muted-foreground">
                        {profile.codec} · WebRTC
                      </span>
                    </span>
                  </DropdownMenuRadioItem>
                ))
              : null}
            <DropdownMenuRadioItem value="jpeg" disabled={disabled}>
              <span className="aperture:flex aperture:min-w-0 aperture:flex-col">
                <span>JPEG</span>
                <span className="aperture:text-xs aperture:text-muted-foreground">
                  WebSocket raster stream
                </span>
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
                    <span className="aperture:flex aperture:min-w-0 aperture:flex-col">
                      <span>{preset.label}</span>
                      <span className="aperture:text-xs aperture:text-muted-foreground">
                        {preset.detail}
                      </span>
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

// Describes who else decides the shared size: another client, or an explicit resize.
function viewportSizeController(control: UseBrowserControlResult) {
  const ownership = control.viewportOwnership;
  const ownerClientId = ownership?.ownerClientId ?? null;
  if (ownership === null || ownerClientId === control.collaboration.clientId) {
    return null;
  }
  const ownerName =
    control.collaboration.participants.find((participant) => participant.clientId === ownerClientId)
      ?.name ?? null;
  if (ownerName !== null) {
    return `Size controlled by ${ownerName}`;
  }
  return control.viewportAutoSync ? "Paused: size was set explicitly" : null;
}

function ViewportPausedIndicator({
  control,
  connected,
}: {
  control: UseBrowserControlResult;
  connected: boolean;
}) {
  const sizeController = viewportSizeController(control);
  if (!control.viewportAutoSync || control.viewportAutoSizeActive || sizeController === null) {
    return null;
  }
  return (
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
                  className="aperture:text-muted-foreground"
                  aria-label={`Auto-size paused. ${sizeController}`}
                />
              }
            />
          }
        >
          <MonitorPause />
        </TooltipTrigger>
        <TooltipContent side="bottom">{sizeController}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="aperture:w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{sizeController}</DropdownMenuLabel>
          <DropdownMenuItem disabled={!connected} onClick={() => control.takeOverViewport()}>
            <Hand />
            Take over size
          </DropdownMenuItem>
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
  const sizeController = viewportSizeController(control);

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Monitor />
        Viewport
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="aperture:w-64">
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
          <span className="aperture:flex aperture:min-w-0 aperture:flex-col">
            <span>Auto-size</span>
            {sizeController !== null ? (
              <span className="aperture:truncate aperture:text-xs aperture:text-muted-foreground">
                {sizeController}
              </span>
            ) : null}
          </span>
        </DropdownMenuCheckboxItem>
        {sizeController !== null ? (
          <DropdownMenuItem
            disabled={!connected || !control.browserViewportSize}
            onClick={() => control.takeOverViewport()}
          >
            <Hand />
            Take over size
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuCheckboxItem
          checked={control.viewportAutoSizeDefault}
          onCheckedChange={control.setViewportAutoSizeDefault}
        >
          <Monitor />
          Auto-size by default
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
      className="aperture:grid aperture:gap-2 aperture:px-2 aperture:py-1.5"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <DropdownMenuLabel className="aperture:px-0">Custom</DropdownMenuLabel>
      <div className="aperture:grid aperture:grid-cols-3 aperture:gap-2">
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
        className="aperture:h-7"
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
      className="aperture:gap-2 aperture:px-2 aperture:py-1.5"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <DropdownMenuLabel className="aperture:px-0">Custom</DropdownMenuLabel>
      <div className="aperture:grid aperture:grid-cols-2 aperture:gap-2">
        <StreamNumberField label="FPS" value={fps} onChange={setFps} />
        <StreamNumberField label="Max Kbps" value={bitrateKbps} onChange={setBitrateKbps} />
      </div>
      <Button
        type="button"
        size="sm"
        className="aperture:h-7 aperture:w-full"
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
    <Field className="aperture:gap-1">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="text"
        inputMode="numeric"
        value={value}
        onChange={(event) => onChange(digitsOnly(event.currentTarget.value))}
        onFocus={(event) => event.currentTarget.select()}
        className="aperture:h-7"
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
    <Field className="aperture:gap-1">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(event) => onChange(decimalNumber(event.currentTarget.value))}
        onFocus={(event) => event.currentTarget.select()}
        className="aperture:h-7"
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
