import { Fragment, useEffect, useState } from "react";
import {
  Camera,
  Circle,
  CircleAlert,
  CircleCheck,
  Film,
  Gauge,
  Images,
  Loader2,
  Square,
} from "lucide-react";
import type {
  EditRecording,
  Pace,
  Recording,
  RecordingOptions,
  Target,
} from "@aperture-browser/session-client";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@aperture-browser/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@aperture-browser/ui/components/tooltip";
import { keptOf, recordingIsEdited, recordingRuns, type Kept } from "../hooks/use-recordings.ts";
import { useStored } from "../hooks/use-stored.ts";
import { failureText, showNotice } from "../notices.ts";
import { useSession, useSessionSnapshot, useWatchedTarget } from "../session.tsx";
import { useWorkbench } from "../workbench/context.tsx";
import {
  Described,
  formatBytes,
  formatDuration,
  formatStarted,
  SettingSubTrigger,
  Thumbnail,
} from "./menu-parts.tsx";

/** How many recordings that ended and screenshots the menu lists. */
const LISTED = 6;

const SETTINGS_KEY = "aperture.session.recording";

/** How an edit is made, as the workbench offers it. */
export interface EditSettings {
  readonly capture: "continuous" | "bursts";
  readonly idle: "keep" | "cut" | "speed";
  readonly ripple: boolean;
  readonly fps: 30 | 60;
}

/** What a recording is started and stopped with, as this browser remembers it. */
export interface RecordingSettings extends EditSettings {
  /** A new recording goes on with whichever tab automation acts on. */
  readonly follow: boolean;
}

const DEFAULT_SETTINGS: RecordingSettings = {
  follow: false,
  capture: "continuous",
  idle: "keep",
  ripple: false,
  fps: 60,
};

const CAPTURES = { continuous: "Continuous", bursts: "Bursts" } as const;
const IDLES = { keep: "Keep", cut: "Cut", speed: "Speed up" } as const;
const RATES = [30, 60] as const;

const isSettings = (value: unknown): value is RecordingSettings => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { follow, capture, idle, ripple, fps } = value as Record<string, unknown>;
  return (
    typeof follow === "boolean" &&
    typeof capture === "string" &&
    capture in CAPTURES &&
    typeof idle === "string" &&
    idle in IDLES &&
    typeof ripple === "boolean" &&
    RATES.some((rate) => rate === fps)
  );
};

export function useRecordingSettings() {
  return useStored(SETTINGS_KEY, DEFAULT_SETTINGS, isSettings);
}

/** What the session is asked for an edit made as `settings` say. */
export function editOptions(settings: EditSettings): EditRecording {
  const bursts = settings.capture === "bursts";
  return {
    capture: settings.capture,
    // Bursts keep only what happens, so there are no quiet stretches to shorten.
    idle: bursts || settings.idle === "keep" ? null : settings.idle,
    ripple: settings.ripple,
    fps: settings.fps,
  };
}

/** What the workbench offers of the options an edit was made with. */
export function editSettings(options: RecordingOptions | undefined): EditSettings {
  if (options === undefined) {
    return DEFAULT_SETTINGS;
  }
  return {
    capture: options.capture,
    idle: options.idle ?? "keep",
    ripple: options.ripple,
    fps: options.fps > 30 ? 60 : 30,
  };
}

/** Starts a recording of the watched tab. */
export function RecordItem() {
  const { recordings } = useWorkbench();
  const snapshot = useSessionSnapshot();
  const [settings] = useRecordingSettings();
  const watched = useWatchedTarget();
  const allowed = snapshot.features.recordings.write;
  const recordsWatched = recordings.recordings.some(
    (one) => recordingRuns(one) && one.tab === watched?.tab,
  );
  const canStart =
    snapshot.connection.state === "open" &&
    allowed &&
    watched !== undefined &&
    !recordsWatched &&
    !recordings.busy;

  const start = () => {
    if (watched === undefined) {
      return;
    }
    recordings.start({ tab: watched.tab, follow: settings.follow }).catch((cause: unknown) => {
      showNotice({
        level: "error",
        message: "The recording did not start",
        description: failureText(cause),
      });
    });
  };

  return (
    <DropdownMenuItem disabled={!canStart} onClick={start}>
      <Circle />
      {allowed ? (
        "Record this tab"
      ) : (
        <Described title="Record this tab">Not yours to make here</Described>
      )}
    </DropdownMenuItem>
  );
}

/** The recordings that run, each with the means to stop it. */
export function RunningRecordingItems() {
  const { recordings } = useWorkbench();
  const snapshot = useSessionSnapshot();
  const running = recordings.recordings.filter(recordingRuns);
  const now = useNow(running.length > 0);
  const allowed = snapshot.features.recordings.write;
  const [settings] = useRecordingSettings();

  // One press: the edit is made as this browser last chose, which the menu shows below.
  const stop = (recording: Recording) => {
    recordings.stop(recording.id, editOptions(settings)).catch((cause: unknown) => {
      showNotice({
        level: "error",
        message: "The recording did not stop",
        description: failureText(cause),
      });
    });
  };

  return running.map((recording) => (
    <Fragment key={recording.id}>
      <DropdownMenuLabel>
        <span className="aperture:flex aperture:min-w-0 aperture:items-center aperture:justify-between aperture:gap-2">
          <span className="aperture:flex aperture:min-w-0 aperture:items-center aperture:gap-1.5">
            <span className="aperture:size-2 aperture:shrink-0 aperture:animate-pulse aperture:rounded-full aperture:bg-destructive" />
            <span className="aperture:truncate">{targetName(snapshot.targets, recording.tab)}</span>
          </span>
          <span className="aperture:shrink-0 aperture:tabular-nums">
            {formatDuration(now - recording.started_at_ms)}
          </span>
        </span>
      </DropdownMenuLabel>
      <DropdownMenuItem disabled={recordings.busy || !allowed} onClick={() => stop(recording)}>
        <Square />
        Stop recording
      </DropdownMenuItem>
    </Fragment>
  ));
}

/**
 * What the session kept of its tabs: the recordings that ended and the screenshots, as one
 * list. Each opens in the gallery.
 */
export function KeptItems() {
  const { recordings, view } = useWorkbench();
  const session = useSession();
  const kept = keptOf(recordings);

  if (kept.length === 0) {
    return null;
  }
  return (
    <>
      <DropdownMenuLabel>Recordings and screenshots</DropdownMenuLabel>
      {kept.slice(0, LISTED).map((one) => (
        <DropdownMenuItem
          key={one.id}
          data-kept={one.kind}
          data-kept-id={one.id}
          onClick={() => view(one.id)}
        >
          <Thumbnail src={keptPreview(one, session.fileUrl)}>
            {one.kind === "recording" ? <Film /> : <Camera />}
          </Thumbnail>
          <span className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:flex-col">
            <span className="aperture:tabular-nums">{formatStarted(one.at)}</span>
            <KeptFacts kept={one} />
          </span>
        </DropdownMenuItem>
      ))}
      {kept.length > LISTED ? (
        <DropdownMenuItem onClick={() => view(kept[0]?.id)}>
          <Images />
          All {kept.length}
        </DropdownMenuItem>
      ) : null}
    </>
  );
}

export function keptPreview(kept: Kept, fileUrl: (path: string) => string): string | undefined {
  if (kept.kind === "screenshot") {
    return fileUrl(kept.screenshot.preview);
  }
  return kept.recording.preview === null ? undefined : fileUrl(kept.recording.preview);
}

/** What a kept thing is and how it went, in a line. */
export function KeptFacts({ kept }: { kept: Kept }) {
  if (kept.kind === "screenshot") {
    return (
      <span className="aperture:truncate aperture:text-xs aperture:text-muted-foreground">
        Screenshot · {formatBytes(kept.screenshot.bytes)}
      </span>
    );
  }
  const { recording } = kept;
  const editing = recordingIsEdited(recording);
  const failed = recording.state === "failed" || recording.edit?.state === "failed";
  let state = "Finished";
  if (recording.state === "failed") {
    state = "Failed";
  } else if (editing) {
    state = "Editing";
  } else if (recording.edit?.state === "failed") {
    state = "Edit failed";
  }
  const facts = [
    "Recording",
    recording.duration_ms === null ? undefined : formatDuration(recording.duration_ms),
    recording.bytes === null ? undefined : formatBytes(recording.bytes),
    state,
  ].filter((fact) => fact !== undefined);

  return (
    <span
      data-recording-state={state}
      className="aperture:flex aperture:min-w-0 aperture:items-center aperture:gap-1 aperture:text-xs aperture:text-muted-foreground aperture:[&_svg]:size-3 aperture:[&_svg]:shrink-0"
    >
      {editing ? <Loader2 className="aperture:animate-spin" /> : null}
      {!editing && failed ? <CircleAlert className="aperture:text-destructive" /> : null}
      {!editing && !failed ? <CircleCheck className="aperture:text-emerald-600" /> : null}
      <span className="aperture:truncate">{facts.join(" · ")}</span>
    </span>
  );
}

/** Takes a screenshot of the watched tab, which the session keeps in its files. */
export function ScreenshotItem() {
  const { recordings } = useWorkbench();
  const snapshot = useSessionSnapshot();
  const watched = useWatchedTarget();
  const allowed = snapshot.features.recordings.write;
  const takes = snapshot.connection.state === "open" && allowed && watched !== undefined;

  const take = () => {
    if (watched === undefined) {
      return;
    }
    recordings.takeScreenshot(watched.tab).then(
      () =>
        showNotice({
          level: "info",
          message: "Screenshot taken",
          description: "It is in the recording menu and in the session's files.",
        }),
      (cause: unknown) =>
        showNotice({
          level: "error",
          message: "The screenshot was not taken",
          description: failureText(cause),
        }),
    );
  };

  return (
    <DropdownMenuItem disabled={!takes} closeOnClick={false} onClick={take}>
      <Camera />
      {allowed ? "Screenshot" : <Described title="Screenshot">Not yours to make here</Described>}
    </DropdownMenuItem>
  );
}

/** How a new recording is made, and how the one that stops is edited. */
export function RecordingSettingsItems() {
  const [settings, onChange] = useRecordingSettings();

  return (
    <>
      <DropdownMenuLabel>New recording</DropdownMenuLabel>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuCheckboxItem
              checked={settings.follow}
              closeOnClick={false}
              onCheckedChange={(follow) => onChange({ ...settings, follow })}
            />
          }
        >
          Follow automation
        </TooltipTrigger>
        <TooltipContent side="left">
          The recording goes on with whichever tab automation acts on, in the same video.
        </TooltipContent>
      </Tooltip>
      <DropdownMenuLabel>When a recording stops</DropdownMenuLabel>
      <EditSettingsItems
        settings={settings}
        onChange={(edit) => onChange({ ...settings, ...edit })}
      />
    </>
  );
}

/** The session's pace: how automation moves the pointer in what is recorded. */
export function AutomationPaceItem() {
  const { features } = useWorkbench();
  const session = useSession();
  const snapshot = useSessionSnapshot();

  if (!features.recordings) {
    return null;
  }
  const set = (pace: Pace) => {
    session.pace.set(pace).catch((cause: unknown) => {
      showNotice({
        level: "error",
        message: "The pace was not set",
        description: failureText(cause),
      });
    });
  };
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={!snapshot.features.recordings.write}>
        <Gauge />
        <span className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:items-center aperture:justify-between aperture:gap-3">
          <span data-menu-title="" className="aperture:shrink-0">
            Automation pace
          </span>
          <span className="aperture:truncate aperture:text-muted-foreground">
            {PACES[snapshot.pace]}
          </span>
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="aperture:w-64">
        <DropdownMenuRadioGroup
          aria-label="Automation pace"
          value={snapshot.pace}
          onValueChange={(value) => {
            if (value === "instant" || value === "fast" || value === "slow") {
              set(value);
            }
          }}
        >
          <DropdownMenuRadioItem value="instant" closeOnClick={false}>
            <Described title="Instant">The pointer jumps straight to each action.</Described>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="fast" closeOnClick={false}>
            <Described title="Fast">
              In a recorded tab the pointer travels there, quickly but so that the eye can follow.
            </Described>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="slow" closeOnClick={false}>
            <Described title="Slow">Unhurried travel and longer pauses, for demos.</Described>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

const PACES = { instant: "Instant", fast: "Fast", slow: "Slow" } as const;

/** How an edit is made: what a recording is stopped with, or edited again with. */
export function EditSettingsItems({
  settings,
  onChange,
}: {
  settings: EditSettings;
  onChange: (settings: EditSettings) => void;
}) {
  const bursts = settings.capture === "bursts";

  return (
    <>
      <DropdownMenuSub>
        <SettingSubTrigger name="Capture" value={CAPTURES[settings.capture]} />
        <DropdownMenuSubContent className="aperture:w-64">
          <DropdownMenuRadioGroup
            aria-label="Capture"
            value={settings.capture}
            onValueChange={(value) => {
              if (value === "continuous" || value === "bursts") {
                onChange({ ...settings, capture: value });
              }
            }}
          >
            <DropdownMenuRadioItem value="continuous" closeOnClick={false}>
              <Described title="Continuous">
                Keep the tab from start to stop, with what is done by hand.
              </Described>
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="bursts" closeOnClick={false}>
              <Described title="Automation bursts">
                Keep only the stretches around what automation did. Clicking or typing here starts
                none.
              </Described>
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSub>
        <SettingSubTrigger
          name="Quiet stretches"
          value={bursts ? "Continuous only" : IDLES[settings.idle]}
        />
        <DropdownMenuSubContent className="aperture:w-64">
          <DropdownMenuRadioGroup
            aria-label="Quiet stretches"
            value={settings.idle}
            onValueChange={(value) => {
              if (value === "keep" || value === "cut" || value === "speed") {
                onChange({ ...settings, idle: value });
              }
            }}
          >
            <DropdownMenuRadioItem value="keep" disabled={bursts} closeOnClick={false}>
              <Described title="Keep">Leave pauses as long as they were.</Described>
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="cut" disabled={bursts} closeOnClick={false}>
              <Described title="Cut">Leave out the stretches in which nothing happens.</Described>
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="speed" disabled={bursts} closeOnClick={false}>
              <Described title="Speed up">Play those stretches faster.</Described>
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSub>
        <SettingSubTrigger name="Frame rate" value={`${settings.fps} fps`} />
        <DropdownMenuSubContent className="aperture:w-44">
          <DropdownMenuRadioGroup
            aria-label="Frame rate"
            value={String(settings.fps)}
            onValueChange={(value) => {
              const fps = RATES.find((rate) => String(rate) === value);
              if (fps !== undefined) {
                onChange({ ...settings, fps });
              }
            }}
          >
            {RATES.map((rate) => (
              <DropdownMenuRadioItem key={rate} value={String(rate)} closeOnClick={false}>
                {rate} fps
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuCheckboxItem
              checked={settings.ripple}
              closeOnClick={false}
              onCheckedChange={(ripple) => onChange({ ...settings, ripple })}
            />
          }
        >
          Highlight clicks
        </TooltipTrigger>
        <TooltipContent side="left">
          Marks clicks with a ripple in the recording edit. The raw recording stays as it is.
        </TooltipContent>
      </Tooltip>
    </>
  );
}

function targetName(targets: readonly Target[], tab: number): string {
  const target = targets.find((one) => one.tab === tab);
  if (target === undefined) {
    return "A closed tab";
  }
  return target.title.trim() === "" ? target.url : target.title;
}

function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!ticking) {
      return undefined;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  return now;
}
