import { cn } from "@aperture-browser/ui/utils";
import { AppWindow } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type Session, useSessionTargetsQuery } from "#/features/session/session.queries.ts";

/** Where the picture of what a session shows is: now, while it runs, and last, while it rests. */
export function useSessionPicture(session: Session, width: number) {
  const shown = useSessionTargetsQuery(session);
  const target = shown.data?.targets[0];
  // A running session is asked what it shows; what was kept is of one that rests.
  const asking = session.observedState === "running" && shown.data === undefined && !shown.isError;
  const source =
    session.path === null || asking
      ? undefined
      : target === undefined
        ? // Kept when it was last suspended; a session that never was has none.
          `${session.path}/preview.png?at=${session.observedAt.epochMilliseconds}`
        : // What the page shows changes while its address does not.
          `${session.path}/targets/${target.tab}/screenshot.png?width=${width}&at=${shown.data?.at}`;
  return { source, target, more: (shown.data?.targets.length ?? 0) - 1 };
}

type SessionPictureProps = {
  source: string | undefined;
  className?: string;
  /** Classes for the mark that stands where there is no picture. */
  markClassName?: string;
};

/**
 * The picture at the address, once it has come: the one before stays until then, so that a
 * picture asked for anew does not blink out while it loads. One that does not come leaves the
 * one before where there is one.
 */
function useLoaded(source: string | undefined) {
  const [loaded, setLoaded] = useState<string>();
  const shown = useRef<string>(undefined);
  useEffect(() => {
    if (source === undefined) {
      return undefined;
    }
    // Fetched in place of preloaded: a picture its session will not have kept is asked for
    // anew when an image is pointed at it, and blinks out all the same.
    const asking = new AbortController();
    void fetch(source, { signal: asking.signal })
      .then((answer) => (answer.ok ? answer.blob() : undefined))
      .then((picture) => {
        if (picture === undefined || asking.signal.aborted) {
          return;
        }
        const before = shown.current;
        shown.current = URL.createObjectURL(picture);
        setLoaded(shown.current);
        // Let go once the new one is drawn in its place.
        if (before !== undefined) {
          requestAnimationFrame(() => requestAnimationFrame(() => URL.revokeObjectURL(before)));
        }
      })
      .catch(() => undefined);
    return () => asking.abort();
  }, [source]);
  useEffect(
    () => () => {
      if (shown.current !== undefined) {
        URL.revokeObjectURL(shown.current);
      }
    },
    [],
  );
  return loaded;
}

/** A session's picture, and a mark in its place where it has none. */
export function SessionPicture({ source, className, markClassName }: SessionPictureProps) {
  const loaded = useLoaded(source);
  if (loaded === undefined) {
    return (
      <span
        className={cn(
          "aperture:flex aperture:size-full aperture:items-center aperture:justify-center aperture:text-muted-foreground",
          className,
        )}
      >
        <AppWindow className={cn("aperture:size-8", markClassName)} />
      </span>
    );
  }
  return (
    <img
      alt=""
      src={loaded}
      className={cn("aperture:size-full aperture:object-cover aperture:object-top", className)}
    />
  );
}
