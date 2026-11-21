import { cn } from "@aperture-browser/ui/utils";
import { AppWindow } from "lucide-react";
import { useState } from "react";
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

/** A session's picture, and a mark in its place where it has none. */
export function SessionPicture({ source, className, markClassName }: SessionPictureProps) {
  // Which address gave no picture: another one is tried anew.
  const [missing, setMissing] = useState<string>();
  if (source === undefined || missing === source) {
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
      src={source}
      onError={() => setMissing(source)}
      className={cn("aperture:size-full aperture:object-cover aperture:object-top", className)}
    />
  );
}
