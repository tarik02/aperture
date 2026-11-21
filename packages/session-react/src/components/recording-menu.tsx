import { Fragment, useEffect, useState } from "react";
import {
  Camera,
  Circle,
  CircleAlert,
  CircleCheck,
  Film,
  Images,
  Loader2,
  Square,
} from "lucide-react";
import type { Recording, StartRecording, Target } from "@aperture-browser/session-client";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
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

/** What a new recording is started with, as this browser remembers it. */
export interface RecordingSettings {
  readonly capture: "continuous" | "bursts";
  readonly idle: "keep" | "cut" | "speed";
  readonly pace: "instant" | "fast" | "slow";
  readonly ripple: boolean;
}

const DEFAULT_SETTINGS: RecordingSettings = {
  capture: "continuous",
  idle: "keep",
  pace: "fast",
  ripple: false,
};

const CAPTURES = { continuous: "Continuous", bursts: "Bursts" } as const;
const IDLES = { keep: "Keep", cut: "Cut", speed: "Speed up" } as const;
const PACES = { instant: "Instant", fast: "Fast", slow: "Slow" } as const;

const isSettings = (value: unknown): value is RecordingSettings => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { capture, idle, pace, ripple } = value as Record<string, unknown>;
  return (
    typeof capture === "string" &&
    capture in CAPTURES &&
    typeof idle === "string" &&
    idle in IDLES &&
    typeof pace === "string" &&
    pace in PACES &&
    typeof ripple === "boolean"
  );
};

export function useRecordingSettings() {
  return useStored(SETTINGS_KEY, DEFAULT_SETTINGS, isSettings);
}

function startOptions(tab: number, settings: RecordingSettings): StartRecording {
  const bursts = settings.capture === "bursts";
  return {
    tab,
    capture: settings.capture,
    // Bursts keep only what happens, so there are no quiet stretches to shorten.
    idle: bursts || settings.idle === "keep" ? null : settings.idle,
    pace: settings.pace,
    ripple: settings.ripple,
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
    recordings.start(startOptions(watched.tab, settings)).catch((cause: unknown) => {
      showNotice({
        level: "error",
        message: "The recording did not start",
        description: failureText(cause),
      });
    });
  };

  return (
    <Tooltip>
      <TooltipTrigger render={<DropdownMenuItem disabled={!canStart} onClick={start} />}>
        <Circle />
        {allowed ? (
          "Record this tab"
        ) : (
          <Described title="Record this tab">Not yours to make here</Described>
        )}
      </TooltipTrigger>
      <TooltipContent side="left">
        Records the watched tab's picture and sound until it is stopped. The raw recording is kept
        in the session's files, and so is the edit made of it with the settings below.
      </TooltipContent>
    </Tooltip>
  );
}

/** The recordings that run, each with the means to stop it. */
export function RunningRecordingItems() {
  const { recordings } = useWorkbench();
  const snapshot = useSessionSnapshot();
  const running = recordings.recordings.filter(recordingRuns);
  const now = useNow(running.length > 0);
  const allowed = snapshot.features.recordings.write;

  const stop = (recording: Recording) => {
    recordings.stop(recording.id).catch((cause: unknown) => {
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

/** How the next recording is made. */
export function RecordingSettingsItems() {
  const [settings, onChange] = useRecordingSettings();
  const bursts = settings.capture === "bursts";

  return (
    <>
      <DropdownMenuLabel>New recording</DropdownMenuLabel>
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
        <SettingSubTrigger name="Automation pace" value={PACES[settings.pace]} />
        <DropdownMenuSubContent className="aperture:w-64">
          <DropdownMenuRadioGroup
            aria-label="Automation pace"
            value={settings.pace}
            onValueChange={(value) => {
              if (value === "instant" || value === "fast" || value === "slow") {
                onChange({ ...settings, pace: value });
              }
            }}
          >
            <DropdownMenuRadioItem value="instant" closeOnClick={false}>
              <Described title="Instant">The pointer jumps straight to each action.</Described>
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="fast" closeOnClick={false}>
              <Described title="Fast">
                The pointer travels there, quickly but so that the eye can follow.
              </Described>
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="slow" closeOnClick={false}>
              <Described title="Slow">Unhurried travel and longer pauses, for demos.</Described>
            </DropdownMenuRadioItem>
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
