import { useEffect, useState } from "react";
import type { Recording } from "@aperture-browser/session-client";
import { useSession } from "../session.tsx";

/** A stretch of the raw video the edit kept, and how much faster it plays there. */
export interface TimelinePiece {
  readonly raw_start_ms: number;
  readonly raw_end_ms: number;
  readonly speed: number;
  readonly edited_start_ms: number;
}

/** Something that happened while the recording ran, in the raw video's time and the edit's. */
export interface TimelineEvent {
  /** `call` for a tool of the automation, `press`, `move`, `wheel`, `caption` and so on. */
  readonly kind: string;
  readonly at_ms: number;
  readonly end_ms: number;
  readonly edited_at_ms: number;
  readonly edited_end_ms: number;
  readonly [field: string]: unknown;
}

/** A recording's timeline, as the session writes it next to the edit. */
export interface RecordingTimeline {
  readonly duration_ms: number;
  readonly edited_duration_ms: number;
  /** The video's size in pixels. */
  readonly width: number;
  readonly height: number;
  readonly map: readonly TimelinePiece[];
  readonly events: readonly TimelineEvent[];
  readonly events_dropped: number;
}

const isTimeline = (value: unknown): value is RecordingTimeline => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { duration_ms, map, events } = value as Record<string, unknown>;
  return typeof duration_ms === "number" && Array.isArray(map) && Array.isArray(events);
};

/** The timeline of a recording whose edit is made; none before, and where there is no edit. */
export function useRecordingTimeline(
  recording: Recording | undefined,
): RecordingTimeline | undefined {
  const session = useSession();
  const file = recording?.edit?.timeline ?? undefined;
  // An edit that was made again has the file of the one before.
  const made = recording?.edit?.made_at_ms ?? 0;
  const [read, setRead] = useState<
    { file: string; made: number; timeline: RecordingTimeline } | undefined
  >();

  useEffect(() => {
    if (file === undefined) {
      return undefined;
    }
    const asking = new AbortController();
    fetch(session.fileUrl(file), { signal: asking.signal, cache: "no-store" })
      .then((answer) => (answer.ok ? answer.json() : undefined))
      .then(
        (timeline: unknown) => {
          if (isTimeline(timeline)) {
            setRead({ file, made, timeline });
          }
        },
        () => {
          // Shown without a timeline.
        },
      );
    return () => asking.abort();
  }, [session, file, made]);

  return read?.file === file && read?.made === made ? read?.timeline : undefined;
}
