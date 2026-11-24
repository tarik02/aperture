import { useCallback, useEffect, useRef, useState } from "react";
import type {
  EditRecording,
  Recording,
  Screenshot,
  StartRecording,
} from "@aperture-browser/session-client";
import { useSession, useSessionSnapshot } from "../session.tsx";

/** How often the recordings are asked for while one is being made or edited. */
const BUSY_EVERY_MS = 2000;
/** How often otherwise: a recording may be started by the session's automation too. */
const IDLE_EVERY_MS = 15_000;

export interface RecordingsControl {
  /** Newest first. */
  readonly recordings: readonly Recording[];
  /** Newest first. */
  readonly screenshots: readonly Screenshot[];
  /** A start or a stop is on its way. */
  readonly busy: boolean;
  readonly refresh: () => void;
  /** Rejects with what the session answered. */
  readonly start: (options?: StartRecording) => Promise<Recording>;
  /** Stops a recording; its edit is made with `options`. */
  readonly stop: (id: string, options?: EditRecording) => Promise<Recording>;
  /** Makes the edit of a stopped recording again, with other options. */
  readonly edit: (id: string, options?: EditRecording) => Promise<Recording>;
  /** Takes a screenshot of a target and keeps it in the session's files. */
  readonly takeScreenshot: (tab: number) => Promise<Screenshot>;
}

export const recordingRuns = (recording: Recording) => recording.state === "recording";

export const recordingIsEdited = (recording: Recording) => recording.edit?.state === "editing";

/**
 * The session's recordings and screenshots. The live protocol does not tell of them, so they are asked for
 * again and again: often while one runs or is edited, seldom otherwise.
 */
export function useRecordings(enabled = true): RecordingsControl {
  const session = useSession();
  const open = useSessionSnapshot().connection.state === "open" && enabled;
  const [recordings, setRecordings] = useState<readonly Recording[]>([]);
  const [screenshots, setScreenshots] = useState<readonly Screenshot[]>([]);
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(0);
  const active = recordings.some((one) => recordingRuns(one) || recordingIsEdited(one));
  const latest = useRef(0);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    let ended = false;
    const ask = () => {
      latest.current += 1;
      const turn = latest.current;
      session.recordings.list().then(
        (listed) => {
          // An answer that was overtaken by a later one tells what is no longer so.
          if (!ended && turn === latest.current) {
            setRecordings(listed.toSorted((a, b) => b.started_at_ms - a.started_at_ms));
          }
        },
        () => {
          // The list stays as it was: the next turn asks again.
        },
      );
      session.screenshots.list().then(
        (listed) => {
          if (!ended && turn === latest.current) {
            setScreenshots(listed);
          }
        },
        () => {},
      );
    };
    ask();
    const timer = setInterval(ask, active ? BUSY_EVERY_MS : IDLE_EVERY_MS);
    return () => {
      ended = true;
      clearInterval(timer);
    };
  }, [session, open, active, asked]);

  const refresh = useCallback(() => setAsked((current) => current + 1), []);

  const start = useCallback(
    async (options?: StartRecording) => {
      setBusy(true);
      try {
        return await session.recordings.start(options);
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [session, refresh],
  );

  const stop = useCallback(
    async (id: string, options?: EditRecording) => {
      setBusy(true);
      try {
        return await session.recordings.stop(id, options);
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [session, refresh],
  );

  const edit = useCallback(
    async (id: string, options?: EditRecording) => {
      try {
        return await session.recordings.edit(id, options);
      } finally {
        refresh();
      }
    },
    [session, refresh],
  );

  const takeScreenshot = useCallback(
    async (tab: number) => {
      try {
        return await session.screenshots.take(tab);
      } finally {
        refresh();
      }
    },
    [session, refresh],
  );

  return { recordings, screenshots, busy, refresh, start, stop, edit, takeScreenshot };
}

/** Something the session kept of a tab: a recording that ended, or a screenshot. */
export type Kept =
  | {
      readonly kind: "recording";
      readonly id: string;
      readonly at: number;
      readonly recording: Recording;
    }
  | {
      readonly kind: "screenshot";
      readonly id: string;
      readonly at: number;
      readonly screenshot: Screenshot;
    };

/** The recordings that ended and the screenshots as one list, newest first. */
export function keptOf(control: RecordingsControl): readonly Kept[] {
  const recordings = control.recordings
    .filter((recording) => !recordingRuns(recording))
    .map(
      (recording): Kept => ({
        kind: "recording",
        id: recording.id,
        at: recording.started_at_ms,
        recording,
      }),
    );
  const screenshots = control.screenshots.map(
    (screenshot): Kept => ({
      kind: "screenshot",
      id: screenshot.id,
      at: screenshot.taken_at_ms,
      screenshot,
    }),
  );
  return [...recordings, ...screenshots].toSorted((left, right) => right.at - left.at);
}
