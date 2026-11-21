import { Link } from "@tanstack/react-router";
import { cn } from "@aperture-browser/ui/utils";
import { AppWindow } from "lucide-react";
import { TagList } from "#/components/tag-list.tsx";
import { SessionActionsMenu } from "#/features/session/session-actions-menu.tsx";
import { type Session, useSessionTargetsQuery } from "#/features/session/session.queries.ts";
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
  const shown = useSessionTargetsQuery(session);
  const target = shown.data?.targets[0];
  const more = (shown.data?.targets.length ?? 0) - 1;

  return (
    <article
      data-console-session={session.id}
      data-selected={selected ? "" : undefined}
      className="aperture:group/card aperture:relative aperture:flex aperture:flex-col aperture:overflow-hidden aperture:rounded-xl aperture:border aperture:bg-card aperture:data-selected:ring-2 aperture:data-selected:ring-ring"
    >
      <label
        className={cn(
          "aperture:absolute aperture:top-2 aperture:right-2 aperture:z-10 aperture:flex aperture:size-6 aperture:items-center aperture:justify-center aperture:rounded-md aperture:bg-background/90 aperture:opacity-0 aperture:transition-opacity aperture:group-hover/card:opacity-100 aperture:focus-within:opacity-100",
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
      <Link
        to="/-/sessions/$sessionId"
        params={{ sessionId: session.id }}
        data-console-session-open
        className="aperture:relative aperture:block aperture:aspect-video aperture:bg-muted"
      >
        {target !== undefined && session.path !== null ? (
          <img
            alt=""
            // What the page shows changes while its address does not.
            src={`${session.path}/targets/${target.tab}/screenshot.png?width=${THUMBNAIL_WIDTH}&at=${shown.data?.at}`}
            className="aperture:size-full aperture:object-cover aperture:object-top"
          />
        ) : (
          <span className="aperture:flex aperture:size-full aperture:items-center aperture:justify-center aperture:text-muted-foreground">
            <AppWindow className="aperture:size-8" />
          </span>
        )}
        <span className="aperture:absolute aperture:top-2 aperture:left-2">
          <SessionStatusBadge session={session} />
        </span>
      </Link>
      <div className="aperture:flex aperture:items-start aperture:gap-2 aperture:p-3">
        <div className="aperture:grid aperture:min-w-0 aperture:flex-1 aperture:gap-0.5">
          <span className="aperture:truncate aperture:text-sm aperture:font-medium">
            {session.label ?? (target?.title || "Session")}
            {more > 0 ? <span className="aperture:text-muted-foreground"> +{more}</span> : null}
          </span>
          <span className="aperture:truncate aperture:text-xs aperture:text-muted-foreground">
            {target?.url ?? when.format(new Date(session.createdAt.epochMilliseconds))}
          </span>
          <span className="aperture:truncate aperture:font-mono aperture:text-[0.7rem] aperture:text-muted-foreground/70">
            {session.id}
          </span>
          <TagList tags={session.tags} />
        </div>
        <SessionActionsMenu session={session} />
      </div>
    </article>
  );
}
