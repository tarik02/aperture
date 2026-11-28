import { cn } from "@aperture-browser/ui/utils";
import { AppWindow } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  type Session,
  useSessionKeptTabsQuery,
  useSessionTargetsQuery,
} from "#/features/session/session.queries.ts";

/** A tab of a session, with where its small picture and its page's icon are. */
export type ShownTab = {
  tab: number;
  title: string;
  url: string;
  /** None where none was kept of it. */
  picture: string | undefined;
  icon: string | undefined;
  /** It is the tab watched last, which whoever opens the session watches. */
  watched: boolean;
};

/**
 * The tabs of a session, and where the picture of what it shows is: of the tab watched
 * last, now while it runs and as it was suspended while it rests.
 */
export function useSessionPicture(session: Session, width: number) {
  const shown = useSessionTargetsQuery(session);
  const kept = useSessionKeptTabsQuery(session);
  const { path } = session;
  const at = session.observedAt.epochMilliseconds;
  // What a session told of its tabs while it ran is not what it has once it rests. One
  // being restored runs for whoever looks, and keeps what it told meanwhile.
  const runs = session.observedState === "running" || session.observedState === "restoring";
  const live = runs ? shown.data : undefined;
  const listed: ReadonlyArray<ShownTab> =
    path === null
      ? []
      : live !== undefined
        ? live.targets.map((target) => ({
            tab: target.tab,
            title: target.title,
            url: target.url,
            // What the page shows changes while its address does not.
            picture: `${path}/targets/${target.tab}/preview.png?at=${live.at}`,
            icon: `${path}/targets/${target.tab}/favicon`,
            watched: target.watched === true,
          }))
        : (kept.data?.tabs.map((tab) => ({
            tab: tab.tab,
            title: tab.title,
            url: tab.url,
            picture: tab.picture ? `${path}/previews/${tab.tab}?at=${at}` : undefined,
            icon: tab.icon === null ? undefined : `${path}/previews/${tab.tab}/favicon?at=${at}`,
            watched: tab.tab === kept.data?.watched,
          })) ?? []);
  // In the order the tabs were made, whichever of the two tells of them.
  const tabs = listed.toSorted((one, other) => one.tab - other.tab);
  // Whoever opens the session watches the newest where none was watched.
  const target = tabs.find((tab) => tab.watched) ?? tabs.at(-1);
  // A running session is asked what it shows; what was kept is of one that rests.
  const asking = runs && shown.data === undefined && !shown.isError;
  const source =
    path === null || asking
      ? undefined
      : live === undefined || target === undefined
        ? // Kept when it was last suspended, of the tab watched last; a session that never
          // was has none.
          `${path}/preview.png?at=${at}`
        : `${path}/targets/${target.tab}/screenshot.png?width=${width}&at=${live.at}`;
  return { source, target, tabs, more: tabs.length - 1 };
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

/** The icon of a tab's page; nothing where its page has none. */
export function TabIcon({ source, className }: { source: string | undefined; className?: string }) {
  const [missing, setMissing] = useState<string>();
  return source === undefined || missing === source ? null : (
    <img
      alt=""
      aria-hidden
      src={source}
      onError={() => setMissing(source)}
      className={cn("aperture:size-4 aperture:shrink-0 aperture:object-contain", className)}
    />
  );
}
