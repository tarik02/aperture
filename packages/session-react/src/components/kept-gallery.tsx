import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Camera,
  ChevronLeft,
  ChevronRight,
  Download,
  Film,
  PanelRight,
  Pause,
  Play,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { Button } from "@aperture-browser/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import { cn } from "@aperture-browser/ui/utils";
import { keptOf, type Kept } from "../hooks/use-recordings.ts";
import {
  useRecordingTimeline,
  type RecordingTimeline,
  type TimelineEvent,
} from "../hooks/use-timeline.ts";
import { useSession } from "../session.tsx";
import { useWorkbench } from "../workbench/context.tsx";
import { formatDuration, formatStarted, Thumbnail } from "./menu-parts.tsx";
import { KeptFacts, keptPreview } from "./recording-menu.tsx";

interface Size {
  readonly width: number;
  readonly height: number;
}

/** What the dialog is as wide as until what it shows has told its size. */
const UNKNOWN: Size = { width: 1280, height: 720 };

/** How long the bars over the picture stay once the pointer rests. */
const BARS_STAY_MS = 2500;

const BAR =
  "aperture:absolute aperture:inset-x-0 aperture:z-10 aperture:flex aperture:items-center aperture:gap-2 aperture:bg-background/70 aperture:backdrop-blur-md aperture:transition-opacity aperture:duration-200";

/**
 * One of the session's recordings or screenshots, as large as the window lets it be and no
 * larger than it is: a screenshot as the picture it is, a recording in a player that shows
 * what happened in it. The others are a panel away. Opened by the workbench's `view`.
 */
export function KeptGallery() {
  const { recordings, viewed, view } = useWorkbench();
  const session = useSession();
  const kept = keptOf(recordings);
  // What was shown stays while the dialog closes: it leaves as it was, not emptied.
  const last = useRef(viewed);
  if (viewed !== undefined) {
    last.current = viewed;
  }
  const showing = viewed ?? last.current;
  const at = kept.findIndex((one) => one.id === showing);
  const shown = kept[at];
  const [listed, setListed] = useState(false);
  const [size, setSize] = useState<{ id: string; size: Size } | undefined>(undefined);
  const content =
    (size !== undefined && size.id === shown?.id ? size.size : undefined) ?? sizeOf(shown);

  // The bars show while the pointer moves, and while it rests on one of them.
  const [moved, setMoved] = useState(0);
  const [awake, setAwake] = useState(true);
  const [onBar, setOnBar] = useState(false);
  const [resting, setResting] = useState(true);
  useEffect(() => {
    setAwake(true);
    const sleeping = setTimeout(() => setAwake(false), BARS_STAY_MS);
    return () => clearTimeout(sleeping);
  }, [moved, showing]);
  const bars =
    awake || onBar || listed || shown === undefined || (shown.kind === "recording" && resting);
  const bar = {
    "data-kept-bars": bars ? "shown" : "hidden",
    onPointerEnter: () => setOnBar(true),
    onPointerLeave: () => setOnBar(false),
  };
  const hidden = bars ? undefined : "aperture:pointer-events-none aperture:opacity-0";

  const step = (by: number) => {
    const next = kept[at + by];
    if (next !== undefined) {
      view(next.id);
    }
  };

  return (
    <Dialog
      open={viewed !== undefined}
      onOpenChange={(open) => {
        if (!open) {
          view(undefined);
          setListed(false);
        }
      }}
    >
      <DialogContent
        data-kept-gallery=""
        showCloseButton={false}
        className="aperture:flex aperture:max-w-none aperture:min-w-[min(26rem,calc(100vw-1rem))] aperture:flex-col aperture:gap-0 aperture:overflow-hidden aperture:bg-black aperture:p-0 aperture:max-sm:mx-auto aperture:sm:max-w-none"
        style={{
          // As wide as the picture, and as the window's width and height leave it.
          width: `min(${content.width}px, calc(100vw - 2rem), calc((100svh - 2rem) * ${content.width / content.height}))`,
        }}
        onPointerMove={() => setMoved((count) => count + 1)}
        onKeyDown={() => setMoved((count) => count + 1)}
      >
        <div
          className={cn("aperture:relative aperture:w-full", !bars && "aperture:cursor-none")}
          style={{ aspectRatio: `${content.width} / ${content.height}` }}
        >
          {shown === undefined ? (
            <p className="aperture:flex aperture:size-full aperture:items-center aperture:justify-center aperture:px-4 aperture:text-center aperture:text-sm aperture:text-white/80">
              It is no longer in the session's files.
            </p>
          ) : shown.kind === "screenshot" ? (
            <img
              key={shown.id}
              data-kept-shown="screenshot"
              src={session.fileUrl(shown.screenshot.file)}
              alt=""
              className="aperture:size-full aperture:object-contain"
            />
          ) : (
            <RecordingView
              key={shown.id}
              kept={shown}
              bar={bar}
              hidden={hidden}
              onSize={(told) => setSize({ id: shown.id, size: told })}
              onResting={setResting}
            />
          )}
          <header
            {...bar}
            className={cn(BAR, "aperture:top-0 aperture:h-9 aperture:pr-1 aperture:pl-3", hidden)}
          >
            <DialogTitle className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:items-baseline aperture:gap-2 aperture:text-xs aperture:font-normal">
              <span className="aperture:shrink-0 aperture:font-medium aperture:tabular-nums">
                {shown === undefined ? "Recordings and screenshots" : formatStarted(shown.at)}
              </span>
              {shown === undefined ? null : <KeptFacts kept={shown} />}
              {shown === undefined ? null : (
                <span className="aperture:min-w-0 aperture:flex-1 aperture:truncate aperture:text-muted-foreground">
                  {pageOf(shown)}
                </span>
              )}
            </DialogTitle>
            <div className="aperture:flex aperture:shrink-0 aperture:items-center">
              {shown?.kind === "screenshot" ? (
                <FileLinks
                  href={session.fileUrl(shown.screenshot.file)}
                  file={shown.screenshot.file}
                />
              ) : null}
              <BarButton label="Newer" disabled={at <= 0} onClick={() => step(-1)}>
                <ChevronLeft />
              </BarButton>
              <BarButton
                label="Older"
                disabled={at < 0 || at >= kept.length - 1}
                onClick={() => step(1)}
              >
                <ChevronRight />
              </BarButton>
              <BarButton
                label="All recordings and screenshots"
                pressed={listed}
                data-kept-list-button=""
                onClick={() => setListed(!listed)}
              >
                <PanelRight />
              </BarButton>
              <DialogClose
                render={<Button type="button" variant="ghost" size="icon-xs" aria-label="Close" />}
              >
                <X />
              </DialogClose>
            </div>
          </header>
          {listed ? (
            <KeptList
              kept={kept}
              viewed={showing}
              onView={(id) => {
                view(id);
                setListed(false);
              }}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The size a kept thing says it has, before its picture is there to tell. */
function sizeOf(kept: Kept | undefined): Size {
  if (kept?.kind === "screenshot" && kept.screenshot.width > 0 && kept.screenshot.height > 0) {
    return { width: kept.screenshot.width, height: kept.screenshot.height };
  }
  return UNKNOWN;
}

/** The page a kept thing is of. */
function pageOf(kept: Kept): string {
  const { title, url } = kept.kind === "screenshot" ? kept.screenshot : kept.recording;
  return title.trim() === "" ? url : title;
}

function BarButton({
  label,
  pressed,
  children,
  ...props
}: {
  label: string;
  pressed?: boolean;
  children: ReactNode;
} & Omit<React.ComponentProps<typeof Button>, "children">) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={cn(pressed && "aperture:bg-foreground/10")}
      {...props}
    >
      {children}
    </Button>
  );
}

/**
 * The link every kept file has, to a file on this machine. A file of the session's is
 * shown here or kept, and is no page of its own: the session answers with it as a file.
 */
function FileLinks({ href, file }: { href: string; file: string }) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label="Download"
      title="Download"
      render={<a href={href} download={file.split("/").at(-1) ?? ""} />}
    >
      <Download />
    </Button>
  );
}

function RecordingView({
  kept,
  bar,
  hidden,
  onSize,
  onResting,
}: {
  kept: Kept & { kind: "recording" };
  /** What makes the player's bar one of the bars over the picture. */
  bar: Record<string, unknown>;
  /** The classes that hide the bars, while they are hidden. */
  hidden: string | undefined;
  onSize: (size: Size) => void;
  /** Tells whether the video rests, which keeps the bars in sight. */
  onResting: (resting: boolean) => void;
}) {
  const session = useSession();
  const { recording } = kept;
  const timeline = useRecordingTimeline(recording);
  const edited =
    recording.edit?.state === "finished" && recording.edit.file !== null
      ? recording.edit.file
      : undefined;
  // The edit is what a recording was made for, and what every browser plays.
  const [raw, setRaw] = useState(false);
  const playsRaw = raw || edited === undefined;
  const file = playsRaw ? recording.file : (edited ?? recording.file);
  const src = session.fileUrl(file);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [time, setTime] = useState(0);
  const [length, setLength] = useState(0);
  const [failed, setFailed] = useState<string | undefined>(undefined);

  useEffect(() => {
    onResting(!playing);
    return () => onResting(true);
  }, [playing, onResting]);

  // The playhead moves with the picture, which says where it is less often than it is drawn.
  useEffect(() => {
    if (!playing) {
      return undefined;
    }
    let frame = requestAnimationFrame(function follow() {
      setTime(videoRef.current?.currentTime ?? 0);
      frame = requestAnimationFrame(follow);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const told = playsRaw ? timeline?.duration_ms : timeline?.edited_duration_ms;
  const duration = told === undefined ? length : told / 1000;

  const toggle = () => {
    const video = videoRef.current;
    if (video === null) {
      return;
    }
    if (video.paused) {
      void video.play().catch(() => {});
    } else {
      video.pause();
    }
  };

  const seek = (seconds: number) => {
    const video = videoRef.current;
    if (video !== null) {
      video.currentTime = Math.min(Math.max(seconds, 0), duration);
      setTime(video.currentTime);
    }
  };

  return (
    <div
      className="aperture:flex aperture:size-full aperture:items-center aperture:justify-center"
      onKeyDown={(event) => {
        if (event.key === " " && !(event.target instanceof HTMLButtonElement)) {
          event.preventDefault();
          toggle();
        }
        if (event.key === "ArrowLeft") {
          seek(time - 5);
        }
        if (event.key === "ArrowRight") {
          seek(time + 5);
        }
      }}
    >
      {failed === undefined ? (
        <video
          key={src}
          ref={videoRef}
          data-kept-shown="recording"
          src={src}
          poster={keptPreview(kept, session.fileUrl)}
          playsInline
          preload="metadata"
          muted={muted}
          onClick={toggle}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            setLength(Number.isFinite(video.duration) ? video.duration : 0);
            setTime(0);
            if (video.videoWidth > 0 && video.videoHeight > 0) {
              onSize({ width: video.videoWidth, height: video.videoHeight });
            }
          }}
          onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
          onError={() =>
            setFailed(
              recording.failure ??
                (playsRaw && edited !== undefined
                  ? "This browser does not play the raw recording. Download it, or watch the edit."
                  : "This browser does not play the file. Download it instead."),
            )
          }
          className="aperture:size-full aperture:object-contain aperture:outline-none"
        />
      ) : (
        <p className="aperture:max-w-sm aperture:px-4 aperture:text-center aperture:text-sm aperture:text-white/80">
          {failed}
        </p>
      )}
      <div
        {...bar}
        data-kept-player=""
        className={cn(BAR, "aperture:bottom-0 aperture:h-9 aperture:px-1", hidden)}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={playing ? "Pause" : "Play"}
          disabled={failed !== undefined}
          onClick={toggle}
        >
          {playing ? <Pause /> : <Play />}
        </Button>
        <span className="aperture:shrink-0 aperture:text-xs aperture:text-muted-foreground aperture:tabular-nums">
          {formatDuration(time * 1000)} / {formatDuration(duration * 1000)}
        </span>
        <Track duration={duration} time={time} timeline={timeline} raw={playsRaw} onSeek={seek} />
        {edited === undefined ? null : (
          <div className="aperture:flex aperture:shrink-0 aperture:rounded-md aperture:bg-foreground/10 aperture:p-0.5">
            {[false, true].map((one) => (
              <button
                key={String(one)}
                type="button"
                aria-pressed={raw === one}
                title={
                  one
                    ? "The video as it was recorded"
                    : "With the cuts and marks it was started with"
                }
                className={cn(
                  "aperture:rounded aperture:px-1.5 aperture:text-xs aperture:leading-5 aperture:outline-none aperture:focus-visible:ring-2 aperture:focus-visible:ring-ring",
                  raw === one
                    ? "aperture:bg-background aperture:shadow-xs"
                    : "aperture:text-muted-foreground aperture:hover:text-foreground",
                )}
                onClick={() => {
                  setRaw(one);
                  setFailed(undefined);
                  setPlaying(false);
                }}
              >
                {one ? "Raw" : "Edit"}
              </button>
            ))}
          </div>
        )}
        <div className="aperture:flex aperture:shrink-0 aperture:items-center">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={muted ? "Unmute" : "Mute"}
            aria-pressed={muted}
            onClick={() => setMuted(!muted)}
          >
            {muted ? <VolumeX /> : <Volume2 />}
          </Button>
          <FileLinks href={src} file={file} />
        </div>
      </div>
    </div>
  );
}

/** What an event of the timeline is, in a few words. */
function eventLabel(event: TimelineEvent): string {
  const text = (field: string) => {
    const value = event[field];
    return typeof value === "string" ? value : undefined;
  };
  switch (event.kind) {
    case "call": {
      return `${text("tool") ?? "tool"}${event.ok === false ? " (failed)" : ""}`;
    }
    case "press": {
      const button = text("button") ?? "left";
      const times = event.count === 2 ? "double " : "";
      return button === "left" ? `${times}click` : `${times}${button} click`;
    }
    case "wheel": {
      return "scroll";
    }
    case "caption": {
      return text("text") ?? "caption";
    }
    default: {
      return event.kind;
    }
  }
}

/** Pointer moves and wheel turns no further apart than this are one run of them. */
const RUN_GAP_MS = 300;

/** A stretch of the track: where it is, and what the edit made of it. */
interface Stretch {
  readonly start: number;
  readonly end: number;
  readonly note: string;
  readonly cut: boolean;
}

/** The stretches the edit sped up or cut, in the time of the video that plays. */
function stretches(timeline: RecordingTimeline, raw: boolean): readonly Stretch[] {
  const found: Stretch[] = [];
  let before = 0;
  for (const piece of timeline.map) {
    if (raw && piece.raw_start_ms > before) {
      found.push({ start: before, end: piece.raw_start_ms, note: "Cut from the edit", cut: true });
    }
    before = piece.raw_end_ms;
    if (piece.speed > 1) {
      const length = piece.raw_end_ms - piece.raw_start_ms;
      found.push({
        start: raw ? piece.raw_start_ms : piece.edited_start_ms,
        end: raw ? piece.raw_end_ms : piece.edited_start_ms + length / piece.speed,
        note: raw
          ? `${piece.speed}× faster in the edit`
          : `${piece.speed}× faster than it happened`,
        cut: false,
      });
    }
  }
  if (raw && timeline.duration_ms > before) {
    found.push({ start: before, end: timeline.duration_ms, note: "Cut from the edit", cut: true });
  }
  return found;
}

/**
 * The player's track: where the picture is, where to take it, and what happened when. The
 * automation's tools are bars above the line, clicks are dots on it, and the stretches the
 * edit sped up or cut are marked along it. Pointing tells what is there.
 */
function Track({
  duration,
  time,
  timeline,
  raw,
  onSeek,
}: {
  /** In seconds, as `time` is. */
  duration: number;
  time: number;
  timeline: RecordingTimeline | undefined;
  /** The raw video plays, and not its edit. */
  raw: boolean;
  onSeek: (seconds: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [pointed, setPointed] = useState<number | undefined>(undefined);
  const total = Math.max(duration * 1000, 1);
  const share = (ms: number) => `${Math.min(Math.max(ms / total, 0), 1) * 100}%`;
  const span = (event: TimelineEvent) =>
    raw
      ? ([event.at_ms, event.end_ms] as const)
      : ([event.edited_at_ms, event.edited_end_ms] as const);
  const events = timeline?.events ?? [];
  const calls = events.filter((event) => event.kind === "call");
  const marks = events.filter((event) => !["call", "move", "wheel"].includes(event.kind));
  // The pointer's way and the wheel's turns are many small events: each run of them is one.
  const runs = (kind: string, label: string) => {
    const found: { start: number; end: number; label: string }[] = [];
    for (const event of events) {
      if (event.kind !== kind) {
        continue;
      }
      const [start, end] = span(event);
      const before = found.at(-1);
      if (before !== undefined && start - before.end <= RUN_GAP_MS) {
        before.end = Math.max(before.end, end);
      } else {
        found.push({ start, end, label });
      }
    }
    return found;
  };
  const moves = [...runs("move", "pointer moves"), ...runs("wheel", "scroll")];
  const marked = timeline === undefined ? [] : stretches(timeline, raw);

  const msAt = (clientX: number) => {
    const box = trackRef.current?.getBoundingClientRect();
    if (box === undefined || box.width === 0) {
      return 0;
    }
    return Math.min(Math.max((clientX - box.left) / box.width, 0), 1) * total;
  };

  // What is near enough to the pointer to be meant: a few pixels of the track either way.
  const near = total * 0.012;
  const there =
    pointed === undefined
      ? []
      : [
          ...calls.filter(
            (event) => span(event)[0] - near <= pointed && pointed <= span(event)[1] + near,
          ),
          ...marks.filter((event) => Math.abs(span(event)[0] - pointed) <= near),
        ];
  const moving =
    pointed === undefined
      ? []
      : moves.filter((run) => run.start - near <= pointed && pointed <= run.end + near);
  const stretch = marked.find(
    (one) => pointed !== undefined && one.start <= pointed && pointed <= one.end,
  );

  return (
    <div
      ref={trackRef}
      data-kept-track=""
      role="slider"
      tabIndex={0}
      aria-label="Position in the recording"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(time)}
      aria-valuetext={formatDuration(time * 1000)}
      className="aperture:relative aperture:h-9 aperture:min-w-0 aperture:flex-1 aperture:cursor-pointer aperture:touch-none aperture:outline-none"
      onPointerDown={(event) => {
        onSeek(msAt(event.clientX) / 1000);
        // The drag goes on outside the track; a pointer that cannot be held still seeks.
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Followed while it is over the track.
        }
      }}
      onPointerMove={(event) => {
        setPointed(msAt(event.clientX));
        if (event.buttons === 1) {
          onSeek(msAt(event.clientX) / 1000);
        }
      }}
      onPointerLeave={() => setPointed(undefined)}
    >
      {moves.map((run, index) => (
        <span
          key={index}
          data-kept-run={run.label}
          className="aperture:absolute aperture:top-1.5 aperture:h-0.5 aperture:min-w-0.5 aperture:rounded-full aperture:bg-foreground/35"
          style={{ left: share(run.start), width: `calc(${share(run.end)} - ${share(run.start)})` }}
        />
      ))}
      {calls.map((event, index) => (
        <span
          key={index}
          data-kept-call=""
          className={cn(
            "aperture:absolute aperture:top-2.5 aperture:h-1 aperture:min-w-1 aperture:rounded-full",
            event.ok === false ? "aperture:bg-destructive" : "aperture:bg-sky-500",
          )}
          style={{
            left: share(span(event)[0]),
            width: `calc(${share(span(event)[1])} - ${share(span(event)[0])})`,
          }}
        />
      ))}
      <span className="aperture:absolute aperture:inset-x-0 aperture:top-5 aperture:h-1 aperture:overflow-hidden aperture:rounded-full aperture:bg-foreground/15">
        {marked.map((one, index) => (
          <span
            key={index}
            className={cn(
              "aperture:absolute aperture:inset-y-0",
              one.cut ? "aperture:bg-foreground/35" : "aperture:bg-amber-500/60",
            )}
            style={{
              left: share(one.start),
              width: `calc(${share(one.end)} - ${share(one.start)})`,
            }}
          />
        ))}
        <span
          className="aperture:absolute aperture:inset-y-0 aperture:left-0 aperture:bg-primary/70"
          style={{ width: share(time * 1000) }}
        />
      </span>
      {marks.map((event, index) => (
        <span
          key={index}
          data-kept-mark={event.kind}
          className={cn(
            "aperture:absolute aperture:top-4.5 aperture:size-2 aperture:-translate-x-1/2 aperture:rounded-full aperture:ring-1 aperture:ring-background",
            event.kind === "caption" ? "aperture:bg-amber-500" : "aperture:bg-foreground/70",
          )}
          style={{ left: share(span(event)[0]) }}
        />
      ))}
      <span
        className="aperture:absolute aperture:top-3.5 aperture:h-4 aperture:w-0.5 aperture:-translate-x-1/2 aperture:rounded-full aperture:bg-primary"
        style={{ left: share(time * 1000) }}
      />
      {pointed === undefined ? null : (
        <span
          data-kept-track-tip=""
          className="aperture:pointer-events-none aperture:absolute aperture:bottom-full aperture:z-10 aperture:mb-1 aperture:flex aperture:w-max aperture:max-w-64 aperture:-translate-x-1/2 aperture:flex-col aperture:gap-0.5 aperture:rounded-md aperture:bg-popover aperture:px-2 aperture:py-1 aperture:text-xs aperture:text-popover-foreground aperture:shadow-md aperture:ring-1 aperture:ring-foreground/10"
          style={{ left: `clamp(4rem, ${share(pointed)}, calc(100% - 4rem))` }}
        >
          <span className="aperture:text-muted-foreground aperture:tabular-nums">
            {formatDuration(pointed)}
          </span>
          {there.slice(0, 4).map((event, index) => (
            <span key={index} className="aperture:truncate">
              {eventLabel(event)}
              {span(event)[1] - span(event)[0] >= 100 ? (
                <span className="aperture:text-muted-foreground">
                  {" "}
                  · {((span(event)[1] - span(event)[0]) / 1000).toFixed(1)} s
                </span>
              ) : null}
            </span>
          ))}
          {there.length === 0
            ? moving.slice(0, 2).map((run, index) => <span key={index}>{run.label}</span>)
            : null}
          {stretch === undefined ? null : (
            <span className="aperture:text-muted-foreground">{stretch.note}</span>
          )}
        </span>
      )}
    </div>
  );
}

/** Everything kept, as a panel over the picture's right side. */
function KeptList({
  kept,
  viewed,
  onView,
}: {
  kept: readonly Kept[];
  viewed: string | undefined;
  onView: (id: string) => void;
}) {
  const session = useSession();

  return (
    <div
      data-kept-list=""
      className="aperture:absolute aperture:top-9 aperture:right-0 aperture:bottom-0 aperture:z-20 aperture:flex aperture:w-72 aperture:max-w-full aperture:flex-col aperture:gap-0.5 aperture:overflow-y-auto aperture:border-l aperture:bg-popover aperture:p-1.5 aperture:shadow-lg aperture:animate-in aperture:slide-in-from-right-4 aperture:fade-in-0 aperture:duration-150"
    >
      {kept.map((one) => (
        <button
          key={one.id}
          type="button"
          aria-current={one.id === viewed}
          className={cn(
            "aperture:flex aperture:items-center aperture:gap-2 aperture:rounded-md aperture:p-1.5 aperture:text-left aperture:text-sm aperture:outline-none aperture:hover:bg-muted aperture:focus-visible:bg-muted",
            one.id === viewed && "aperture:bg-muted",
          )}
          onClick={() => onView(one.id)}
        >
          <Thumbnail src={keptPreview(one, session.fileUrl)}>
            {one.kind === "recording" ? <Film /> : <Camera />}
          </Thumbnail>
          <span className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:flex-col">
            <span className="aperture:tabular-nums">{formatStarted(one.at)}</span>
            <KeptFacts kept={one} />
          </span>
        </button>
      ))}
    </div>
  );
}
