import { Link } from "@tanstack/react-router";
import { cn } from "@aperture-browser/ui/utils";
import { TagList } from "#/components/tag-list.tsx";
import {
  SessionActionsMenu,
  SessionContextMenu,
  useSessionActions,
} from "#/features/session/session-actions-menu.tsx";
import { SessionPicture, useSessionPicture } from "#/features/session/session-picture.tsx";
import type { Session } from "#/features/session/session.queries.ts";
import { SessionStatusBadge } from "#/features/session/session-status-badge.tsx";

const THUMBNAIL_WIDTH = 480;

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** A session as one of many: what it shows now, what it is, and what is done with it. */
type SessionCardProps = {
  session: Session;
  selected: boolean;
  onSelect: (selected: boolean, range: boolean) => void;
};

export function SessionCard({ session, selected, onSelect }: SessionCardProps) {
  const picture = useSessionPicture(session, THUMBNAIL_WIDTH);
  const { target, more } = picture;
  const { actions, dialogs } = useSessionActions(session);
  const title = session.label ?? (target?.title || "Session");

  return (
    <>
      <SessionContextMenu actions={actions}>
        <article
          data-console-session={session.id}
          data-selected={selected ? "" : undefined}
          // One shape whatever it shows, so that a row of cards is level.
          className="aperture:group/card aperture:relative aperture:aspect-[4/3] aperture:overflow-hidden aperture:rounded-xl aperture:bg-muted aperture:ring-1 aperture:ring-foreground/10 aperture:data-selected:ring-2 aperture:data-selected:ring-primary"
        >
          <Link
            to="/-/sessions/$sessionId"
            params={{ sessionId: session.id }}
            data-console-session-open
            aria-label={`Open ${title}`}
            className="aperture:absolute aperture:inset-0 aperture:outline-none aperture:focus-visible:ring-3 aperture:focus-visible:ring-ring/50 aperture:focus-visible:ring-inset"
          >
            {/* The mark sits above the middle, which the footer covers part of. */}
            <SessionPicture source={picture.source} markClassName="aperture:mb-16" />
          </Link>
          <span className="aperture:pointer-events-none aperture:absolute aperture:top-2 aperture:left-2">
            <SessionStatusBadge session={session} />
          </span>
          <label
            className={cn(
              "aperture:absolute aperture:top-2 aperture:right-2 aperture:flex aperture:size-6 aperture:items-center aperture:justify-center aperture:rounded-md aperture:bg-background/90 aperture:opacity-0 aperture:transition-opacity aperture:group-hover/card:opacity-100 aperture:focus-within:opacity-100",
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
          <div
            data-console-session-footer
            // Lets a click through to the picture below it: only the menu is its own.
            className="aperture:pointer-events-none aperture:absolute aperture:inset-x-0 aperture:bottom-0 aperture:flex aperture:items-start aperture:gap-2 aperture:border-t aperture:border-foreground/10 aperture:bg-background/85 aperture:py-2 aperture:pr-1.5 aperture:pl-3 aperture:backdrop-blur-md"
          >
            <div className="aperture:grid aperture:min-w-0 aperture:flex-1 aperture:gap-0.5">
              <span className="aperture:truncate aperture:text-sm aperture:font-medium">
                {title}
                {more > 0 ? <span className="aperture:text-muted-foreground"> +{more}</span> : null}
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
                className="aperture:flex-nowrap aperture:overflow-hidden aperture:pt-0.5 aperture:*:shrink-0"
              />
            </div>
            <span className="aperture:pointer-events-auto">
              <SessionActionsMenu actions={actions} />
            </span>
          </div>
        </article>
      </SessionContextMenu>
      {dialogs}
    </>
  );
}
