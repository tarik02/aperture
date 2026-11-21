import { Link } from "@tanstack/react-router";
import { AppWindow } from "lucide-react";
import { SessionActionsMenu } from "#/features/session/session-actions-menu.tsx";
import { type Session, useSessionTargetsQuery } from "#/features/session/session.queries.ts";
import { SessionStatusBadge } from "#/features/session/session-status-badge.tsx";

const THUMBNAIL_WIDTH = 480;

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** A session as one of many: what it shows now, what it is, and what is done with it. */
export function SessionCard({ session }: { session: Session }) {
  const shown = useSessionTargetsQuery(session);
  const target = shown.data?.targets[0];
  const more = (shown.data?.targets.length ?? 0) - 1;

  return (
    <article
      data-console-session={session.id}
      className="aperture:flex aperture:flex-col aperture:overflow-hidden aperture:rounded-xl aperture:border aperture:bg-card"
    >
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
            {target?.title || "Session"}
            {more > 0 ? <span className="aperture:text-muted-foreground"> +{more}</span> : null}
          </span>
          <span className="aperture:truncate aperture:text-xs aperture:text-muted-foreground">
            {target?.url ?? when.format(new Date(session.createdAt.epochMilliseconds))}
          </span>
          <span className="aperture:truncate aperture:font-mono aperture:text-[0.7rem] aperture:text-muted-foreground/70">
            {session.id}
          </span>
        </div>
        <SessionActionsMenu session={session} />
      </div>
    </article>
  );
}
