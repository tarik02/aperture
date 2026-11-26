import { Link } from "@tanstack/react-router";
import { cn } from "@aperture-browser/ui/utils";
import { Layers, Pin } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";
import { TagList } from "#/components/tag-list.tsx";
import {
  SessionActionsMenu,
  SessionContextMenu,
  useSessionActions,
} from "#/features/session/session-actions-menu.tsx";
import { useOpenSession } from "#/features/session/use-open-session.ts";
import {
  type ShownTab,
  SessionPicture,
  TabIcon,
  useSessionPicture,
} from "#/features/session/session-picture.tsx";
import type { Session } from "#/features/session/session.queries.ts";
import { SessionStatusBadge } from "#/features/session/session-status-badge.tsx";
import { when } from "#/lib/when.ts";

const THUMBNAIL_WIDTH = 480;

/** How many sheets stand behind the picture of a session that has more tabs than one. */
const SHEETS_MOST = 2;

/** A session as one of many: what it shows now, what it is, and what is done with it. */
type SessionCardProps = {
  session: Session;
  selected: boolean;
  /** Selects it among the others; without, it is not selected. */
  onSelect: ((selected: boolean, range: boolean) => void) | undefined;
};

export function SessionCard({ session, selected, onSelect }: SessionCardProps) {
  const picture = useSessionPicture(session, THUMBNAIL_WIDTH);
  const { target, tabs } = picture;
  const { actions, dialogs } = useSessionActions(session);
  const open = useOpenSession(session.id, picture.source);
  const title = session.label ?? (target?.title || "Session");
  /** The pointer rests on the card; a finger has no such thing. */
  const [hovered, setHovered] = useState(false);
  /** The tabs were asked for by their button. */
  const [pinned, setPinned] = useState(false);
  const tabsButton = useRef<HTMLButtonElement>(null);
  const many = tabs.length > 1;
  const showsTabs = many && (hovered || pinned);

  const onPointer = (event: PointerEvent) => {
    if (event.pointerType === "mouse") {
      setHovered(event.type === "pointerenter");
    }
  };
  const onStripKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      setPinned(false);
      tabsButton.current?.focus();
    }
  };

  return (
    <>
      <SessionContextMenu actions={actions}>
        <div className="aperture:relative" onPointerEnter={onPointer} onPointerLeave={onPointer}>
          {/* The tabs behind the one it shows, as sheets under the top one. */}
          {Array.from({ length: many ? Math.min(tabs.length - 1, SHEETS_MOST) : 0 }, (_, at) => (
            <div
              key={at}
              aria-hidden
              data-console-session-sheet
              style={{ transform: `translate(${(at + 1) * 5}px, ${-(at + 1) * 5}px)` }}
              className="aperture:absolute aperture:inset-0 aperture:rounded-xl aperture:bg-muted aperture:ring-1 aperture:ring-foreground/10"
            />
          )).toReversed()}
          <article
            data-console-session={session.id}
            data-selected={selected ? "" : undefined}
            // One shape whatever it shows, so that a row of cards is level.
            className="aperture:group/card aperture:relative aperture:aspect-[4/3] aperture:rounded-xl aperture:bg-muted aperture:ring-1 aperture:ring-foreground/10 aperture:data-selected:ring-2 aperture:data-selected:ring-primary"
          >
            {/*
              What it holds is cut to its corners as one picture. Cut each by itself, as
              `overflow` does where one of them blurs what is behind it, the picture shows
              through the footer along the corners: a light arc on a dark page.
            */}
            <div className="aperture:absolute aperture:inset-0 aperture:[clip-path:inset(0_round_calc(var(--radius)*1.4))]">
              <Link
                to="/-/sessions/$sessionId"
                params={{ sessionId: session.id }}
                data-console-session-open
                onClick={open.onClick}
                style={open.moving}
                aria-label={`Open ${title}`}
                className="aperture:absolute aperture:inset-0 aperture:outline-none aperture:focus-visible:ring-3 aperture:focus-visible:ring-ring/50 aperture:focus-visible:ring-inset"
              >
                {/* The mark sits above the middle, which the footer covers part of. */}
                <SessionPicture
                  source={picture.source}
                  markClassName="aperture:mb-16"
                  className={cn(
                    "aperture:transition-[filter] aperture:duration-100",
                    open.opening && "aperture:blur-md",
                  )}
                />
              </Link>
              <span className="aperture:pointer-events-none aperture:absolute aperture:top-2 aperture:left-2 aperture:flex aperture:items-center aperture:gap-1">
                <SessionStatusBadge session={session} />
                {many ? (
                  // Where nothing hovers, and for the keyboard, the tabs come by this.
                  <button
                    ref={tabsButton}
                    type="button"
                    data-console-session-tabs={tabs.length}
                    aria-label={`${tabs.length} tabs`}
                    aria-expanded={showsTabs}
                    onClick={() => setPinned(!pinned)}
                    className="aperture:pointer-events-auto aperture:inline-flex aperture:h-5 aperture:items-center aperture:gap-1 aperture:rounded-4xl aperture:bg-background/90 aperture:px-2 aperture:text-xs aperture:font-medium aperture:ring-1 aperture:ring-foreground/10 aperture:outline-none aperture:focus-visible:ring-3 aperture:focus-visible:ring-ring/50 aperture:pointer-coarse:h-8 aperture:pointer-coarse:px-3 aperture:[&>svg]:size-3"
                  >
                    <Layers />
                    {tabs.length}
                  </button>
                ) : null}
                {session.pinned ? (
                  <span
                    data-console-session-pinned
                    title="Pinned: never deleted by itself"
                    className="aperture:flex aperture:size-5 aperture:items-center aperture:justify-center aperture:rounded-md aperture:bg-background/90 aperture:[&>svg]:size-3"
                  >
                    <Pin aria-label="Pinned" />
                  </span>
                ) : null}
              </span>
              {onSelect === undefined ? null : (
                <label
                  className={cn(
                    // A finger has no hover: there it is always shown, and large enough to press.
                    "aperture:absolute aperture:top-2 aperture:right-2 aperture:flex aperture:size-6 aperture:items-center aperture:justify-center aperture:rounded-md aperture:bg-background/90 aperture:opacity-0 aperture:transition-opacity aperture:group-hover/card:opacity-100 aperture:focus-within:opacity-100 aperture:pointer-coarse:top-1 aperture:pointer-coarse:right-1 aperture:pointer-coarse:size-10 aperture:pointer-coarse:opacity-100 aperture:pointer-coarse:[&>input]:size-5",
                    selected && "aperture:opacity-100",
                  )}
                >
                  <input
                    type="checkbox"
                    aria-label="Select session"
                    checked={selected}
                    // The click knows whether Shift was held, which a change does not tell.
                    onClick={(event) => onSelect(!selected, event.shiftKey)}
                    onChange={() => undefined}
                  />
                </label>
              )}
              <div
                data-console-session-footer
                // Lets a click through to the picture below it: only the menu is its own.
                className="aperture:pointer-events-none aperture:absolute aperture:inset-x-0 aperture:bottom-0 aperture:flex aperture:items-start aperture:gap-2 aperture:border-t aperture:border-foreground/10 aperture:bg-background/85 aperture:py-2 aperture:pr-1.5 aperture:pl-3 aperture:backdrop-blur-md"
              >
                <div className="aperture:grid aperture:min-w-0 aperture:flex-1 aperture:gap-0.5">
                  <span
                    title={title}
                    className="aperture:truncate aperture:text-sm aperture:font-medium"
                  >
                    {title}
                  </span>
                  <span className="aperture:truncate aperture:text-xs aperture:text-muted-foreground">
                    {target?.url ?? when.format(new Date(session.createdAt.epochMilliseconds))}
                  </span>
                  <span className="aperture:truncate aperture:font-mono aperture:text-[0.7rem] aperture:text-muted-foreground/80">
                    {session.id}
                  </span>
                  {/* One line of them: more would take the picture's room. */}
                  <TagList
                    tags={session.tags}
                    most={2}
                    className="aperture:flex-nowrap aperture:pt-0.5"
                  />
                </div>
                <span className="aperture:pointer-events-auto">
                  <SessionActionsMenu actions={actions} />
                </span>
              </div>
            </div>
          </article>
          {showsTabs ? (
            // Below the card, over what is below it: the card's own picture stays to be
            // pressed. With no gap between, which the pointer would leave the card by.
            <div className="aperture:absolute aperture:inset-x-0 aperture:top-full aperture:z-20 aperture:pt-1">
              <ul
                data-console-session-strip
                aria-label={`Tabs of ${title}`}
                onKeyDown={onStripKey}
                className="aperture:flex aperture:animate-in aperture:gap-1.5 aperture:overflow-x-auto aperture:rounded-lg aperture:bg-popover aperture:p-1.5 aperture:text-popover-foreground aperture:shadow-md aperture:ring-1 aperture:ring-foreground/10 aperture:duration-150 aperture:fade-in-0 aperture:slide-in-from-top-1"
              >
                {tabs.map((tab) => (
                  <li key={tab.tab} className="aperture:shrink-0">
                    <TabThumbnail session={session} tab={tab} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </SessionContextMenu>
      {dialogs}
    </>
  );
}

/** One of a session's tabs among the others, which opens the session on it. */
function TabThumbnail({ session, tab }: { session: Session; tab: ShownTab }) {
  const open = useOpenSession(session.id, tab.picture, tab.tab);
  const title = tab.title || tab.url || `Tab ${tab.tab}`;
  return (
    <Link
      to="/-/sessions/$sessionId"
      params={{ sessionId: session.id }}
      search={{ tab: tab.tab }}
      data-console-session-tab={tab.tab}
      data-watched={tab.watched ? "" : undefined}
      onClick={open.onClick}
      aria-label={`Open ${title}`}
      title={title}
      className="aperture:flex aperture:w-28 aperture:flex-col aperture:gap-1 aperture:rounded-md aperture:p-1 aperture:outline-none aperture:hover:bg-muted aperture:focus-visible:ring-3 aperture:focus-visible:ring-ring/50 aperture:data-watched:bg-muted"
    >
      <span
        style={open.moving}
        className="aperture:aspect-[4/3] aperture:overflow-hidden aperture:rounded-sm aperture:bg-muted aperture:ring-1 aperture:ring-foreground/10"
      >
        <SessionPicture
          source={tab.picture}
          markClassName="aperture:size-4"
          className={open.opening ? "aperture:blur-xs" : undefined}
        />
      </span>
      <span className="aperture:flex aperture:min-w-0 aperture:items-center aperture:gap-1 aperture:text-xs">
        <TabIcon source={tab.icon} className="aperture:size-3.5" />
        <span className="aperture:truncate">{title}</span>
      </span>
    </Link>
  );
}

/** A tab of a session as one of many: what it shows, and the session's tab it is. */
export function TabCard({ session, tab }: { session: Session; tab: ShownTab }) {
  const open = useOpenSession(session.id, tab.picture, tab.tab);
  const title = tab.title || tab.url || `Tab ${tab.tab}`;
  return (
    <Link
      to="/-/sessions/$sessionId"
      params={{ sessionId: session.id }}
      search={{ tab: tab.tab }}
      data-console-tab-card={tab.tab}
      data-console-tab-session={session.id}
      data-console-tab-open
      data-watched={tab.watched ? "" : undefined}
      onClick={open.onClick}
      aria-label={`Open ${title}`}
      title={
        tab.watched
          ? `${title}\n${tab.url}\nWatched last: the session opens on it`
          : `${title}\n${tab.url}`
      }
      className="aperture:group/tab aperture:flex aperture:flex-col aperture:gap-1 aperture:rounded-lg aperture:p-1 aperture:outline-none aperture:hover:bg-muted aperture:focus-visible:ring-3 aperture:focus-visible:ring-ring/50"
    >
      <span
        style={open.moving}
        className="aperture:aspect-[16/10] aperture:overflow-hidden aperture:rounded-md aperture:bg-muted aperture:ring-1 aperture:ring-foreground/10 aperture:group-data-watched/tab:ring-2 aperture:group-data-watched/tab:ring-primary"
      >
        <SessionPicture
          source={tab.picture}
          markClassName="aperture:size-5"
          className={cn(
            "aperture:transition-[filter] aperture:duration-100",
            open.opening && "aperture:blur-xs",
          )}
        />
      </span>
      <span className="aperture:flex aperture:min-w-0 aperture:items-center aperture:gap-1 aperture:px-0.5 aperture:text-xs">
        <TabIcon source={tab.icon} className="aperture:size-3.5" />
        <span className="aperture:truncate">{title}</span>
      </span>
    </Link>
  );
}
