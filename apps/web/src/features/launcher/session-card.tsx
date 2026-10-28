import { useNavigate } from "@tanstack/react-router";
import { MoreHorizontal, PlusIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { SelectionLabel, type ItemSelection } from "#/components/resources/selection-checkbox.tsx";
import type { BrowserPage, Session } from "@aperture-browser/api-client";
import { Badge } from "@aperture-browser/ui/components/badge";
import { Button } from "@aperture-browser/ui/components/button";
import { ScrollArea } from "@aperture-browser/ui/components/scroll-area";
import { Spinner } from "@aperture-browser/ui/components/spinner";
import { cn } from "@aperture-browser/ui/utils";
import { SessionThumbnail } from "#/features/launcher/session-thumbnail.tsx";
import {
  openSessionTab,
  sessionHref,
  sessionLinkHandlers,
  type OpenSessionInfo,
} from "#/features/session/open-sessions.ts";
import { SessionActionsMenu } from "#/features/session/session-actions-menu.tsx";
import type { SessionActions, SessionPermissions } from "#/features/session/session-dialogs.tsx";
import {
  isOpenable,
  isReopenable,
  openPages,
  sessionLabel,
  sessionThumbnailUrl,
  targetThumbnailUrl,
  versionedUrl,
} from "#/features/session/session-display.ts";
import { useBrowserStatusQuery } from "#/features/session/session.queries.ts";
import { useInView } from "#/hooks/use-in-view.ts";

const tile =
  "aperture:group aperture:relative aperture:flex aperture:aspect-video aperture:w-32 aperture:shrink-0 aperture:flex-col aperture:overflow-hidden aperture:text-left aperture:outline-none aperture:focus-visible:ring-3 aperture:focus-visible:ring-ring/50 aperture:disabled:cursor-default aperture:disabled:opacity-60";
const tileHover =
  "aperture:after:pointer-events-none aperture:after:absolute aperture:after:inset-0 aperture:after:ring-inset aperture:hover:after:ring-2 aperture:hover:after:ring-foreground/30";

type SessionCardProps = {
  session: Session;
  hidden: boolean;
  openInfo: OpenSessionInfo | undefined;
  actions: SessionActions;
  permissions: SessionPermissions;
  actionsPending: boolean;
  selection?: ItemSelection;
  /** Wraps the card, e.g. in a context menu for the current selection. */
  wrap?: (card: ReactElement) => ReactElement;
};

export function SessionCard({
  session,
  hidden,
  openInfo,
  actions,
  permissions,
  actionsPending,
  selection,
  wrap,
}: SessionCardProps) {
  const navigate = useNavigate();
  const [element, setElement] = useState<HTMLElement | null>(null);
  // Only cards on screen keep their page list fresh; one scrolled back into view catches up.
  const inView = useInView(element);
  const statusQuery = useBrowserStatusQuery(session, { poll: inView });
  const refetchStatus = statusQuery.refetch;
  const statusUpdatedAt = statusQuery.dataUpdatedAt;
  useEffect(() => {
    if (inView && statusUpdatedAt > 0 && Date.now() - statusUpdatedAt > staleAfterMs) {
      void refetchStatus();
    }
  }, [inView, refetchStatus, statusUpdatedAt]);
  const pages = openPages(statusQuery.data?.pages);
  const version = useThumbnailVersion(statusQuery.data, statusUpdatedAt);
  const openable = isOpenable(session.status);
  const running = session.status === "running";
  const openElsewhere = (openInfo?.tabs ?? 0) > 0;

  function navigateTo(targetId?: string, newTab?: boolean) {
    void navigate({
      to: "/-/sessions/$sessionId",
      params: { sessionId: session.id },
      search: newTab ? { newTab: true } : {},
      hash: targetId ? new URLSearchParams({ target: targetId }).toString() : undefined,
    });
  }

  function linkProps(options: { targetId?: string; newTab?: boolean } = {}): LinkProps {
    // Target ids of a suspended session change when it wakes, so its saved pages open the session.
    const targetId = running ? options.targetId : undefined;
    const href = sessionHref(session.id, targetId, options.newTab);
    return {
      href,
      ...sessionLinkHandlers({
        sessionId: session.id,
        href,
        targetId,
        isOpenElsewhere: openElsewhere && !options.newTab,
        onNavigate: () => navigateTo(targetId, options.newTab),
      }),
    };
  }

  const subtitle = [
    session.browserChannel,
    session.baseSnapshotName ? `from ${session.baseSnapshotName}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  let tiles: ReactNode;
  if (openable && statusQuery.isPending) {
    tiles = (
      <div
        className={cn(tile, "aperture:items-center aperture:justify-center aperture:bg-muted/30")}
      >
        <Spinner />
      </div>
    );
  } else if (pages.length > 0) {
    tiles = pages.map((page) => (
      <PageTile
        key={page.targetId}
        page={page}
        thumbnail={
          page.thumbnailAvailable ? targetThumbnail(session, page.targetId, version) : null
        }
        active={openInfo?.targetIds.has(page.targetId) === true}
        {...linkProps({ targetId: page.targetId })}
      />
    ));
  } else {
    tiles = (
      <PlaceholderTile
        session={session}
        version={version}
        actions={actions}
        linkProps={linkProps}
      />
    );
  }

  const card = (
    <article
      ref={setElement}
      className={cn(
        "aperture:group/item aperture:flex aperture:min-w-0 aperture:flex-col aperture:overflow-hidden aperture:rounded-xl aperture:bg-card aperture:ring-1 aperture:ring-foreground/10 aperture:sm:flex-row",
        openElsewhere && "aperture:ring-primary/40",
        selection?.selected && "aperture:bg-muted/40 aperture:ring-2 aperture:ring-primary",
        hidden && "aperture:hidden",
      )}
    >
      <div className="aperture:flex aperture:shrink-0 aperture:flex-col aperture:justify-center aperture:gap-0.5 aperture:border-b aperture:px-3 aperture:py-1.5 aperture:sm:w-56 aperture:sm:border-r aperture:sm:border-b-0">
        <div className="aperture:flex aperture:min-w-0 aperture:items-center aperture:gap-2">
          {selection ? (
            <SelectionLabel selection={selection} label={`Select ${sessionLabel(session)}`}>
              <h3 className="aperture:min-w-0 aperture:flex-1 aperture:truncate aperture:text-sm aperture:font-medium">
                {sessionLabel(session)}
              </h3>
            </SelectionLabel>
          ) : (
            <h3 className="aperture:min-w-0 aperture:flex-1 aperture:truncate aperture:text-sm aperture:font-medium">
              {sessionLabel(session)}
            </h3>
          )}
          <SessionActionsMenu
            session={session}
            actions={actions}
            permissions={permissions}
            onOpen={() =>
              openElsewhere ? openSessionTab(session.id, sessionHref(session.id)) : navigateTo()
            }
            onOpenCdp={() =>
              void navigate({
                to: "/-/sessions/$sessionId",
                params: { sessionId: session.id },
                search: { media: "cdp" },
              })
            }
            trigger={
              <Button
                variant="ghost"
                size="icon-sm"
                className="aperture:-mr-1.5"
                aria-label={`Actions for ${sessionLabel(session)}`}
                disabled={actionsPending}
              >
                <MoreHorizontal />
              </Button>
            }
          />
        </div>
        <div className="aperture:flex aperture:min-w-0 aperture:items-center aperture:gap-1.5">
          <Badge
            variant={running ? "default" : "outline"}
            className="aperture:h-4 aperture:px-1.5 aperture:text-[11px]"
          >
            {session.status}
          </Badge>
          <span className="aperture:min-w-0 aperture:truncate aperture:text-xs aperture:text-muted-foreground">
            {[
              subtitle,
              openElsewhere
                ? `open in ${openInfo!.tabs === 1 ? "a tab" : `${openInfo!.tabs} tabs`}`
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
      </div>
      <ScrollArea scrollbars="horizontal" className="aperture:min-w-0 aperture:flex-1">
        <div className="aperture:flex aperture:gap-px">
          {tiles}
          {openable && permissions.canWrite ? (
            <a
              className={cn(
                tile,
                "aperture:items-center aperture:justify-center aperture:gap-1 aperture:bg-muted/30 aperture:text-xs aperture:text-muted-foreground aperture:hover:bg-muted/60 aperture:hover:text-foreground",
              )}
              title="Open the session with a new tab"
              {...linkProps({ newTab: true })}
            >
              <PlusIcon className="aperture:size-4" />
              New tab
            </a>
          ) : null}
        </div>
      </ScrollArea>
    </article>
  );

  return wrap ? wrap(card) : card;
}

const staleAfterMs = 10_000;
const thumbnailRefreshMs = 60_000;

/**
 * Cache-busts thumbnails when the page list changes, and otherwise at most once a minute, so a
 * poll that finds nothing new doesn't download every thumbnail again.
 */
function useThumbnailVersion(data: unknown, updatedAt: number) {
  const last = useRef({ data, version: updatedAt });
  // Query results keep their identity while nothing in them changed.
  if (data !== last.current.data || updatedAt - last.current.version >= thumbnailRefreshMs) {
    last.current = { data, version: updatedAt };
  }
  return last.current.version;
}

function targetThumbnail(session: Session, targetId: string, version: number) {
  const url = targetThumbnailUrl(session, targetId);
  return url ? versionedUrl(url, version) : null;
}

type LinkProps = {
  href: string;
  onClick: (event: React.MouseEvent<HTMLElement>) => void;
  onAuxClick: (event: React.MouseEvent<HTMLElement>) => void;
};

function PageTile({
  page,
  thumbnail,
  active,
  ...link
}: { page: BrowserPage; thumbnail: string | null; active: boolean } & LinkProps) {
  return (
    <a
      className={cn(tile, tileHover, active && "aperture:after:ring-2 aperture:after:ring-primary")}
      title={`${page.title || page.url}\n${page.url}`}
      {...link}
    >
      <SessionThumbnail src={thumbnail} />
      <Caption title={page.title || "Untitled"} subtitle={page.url} />
    </a>
  );
}

function PlaceholderTile({
  session,
  version,
  actions,
  linkProps,
}: {
  session: Session;
  version: number;
  actions: SessionActions;
  linkProps: () => LinkProps;
}) {
  const thumbnail = sessionThumbnailUrl(session);
  const src = thumbnail ? versionedUrl(thumbnail, version) : null;

  if (session.status === "creating") {
    return (
      <div
        className={cn(tile, "aperture:items-center aperture:justify-center aperture:bg-muted/30")}
      >
        <Spinner />
        <Caption title="Starting" subtitle="Restoring browser state" />
      </div>
    );
  }

  if (isReopenable(session.status)) {
    return (
      <button type="button" className={cn(tile, tileHover)} onClick={() => actions.reopen(session)}>
        <SessionThumbnail src={src} />
        <Caption title="Reopen session" subtitle="Click to reopen" />
      </button>
    );
  }

  if (session.status === "suspended" || session.status === "running") {
    return (
      <a className={cn(tile, tileHover)} {...linkProps()}>
        <SessionThumbnail src={src} />
        <Caption
          title={session.status === "suspended" ? "Suspended" : "No tabs"}
          subtitle={
            session.status === "suspended" ? "Opens and wakes the browser" : "Click to open"
          }
        />
      </a>
    );
  }

  return (
    <div className={cn(tile, "aperture:opacity-60")}>
      <SessionThumbnail src={null} />
      <Caption title={session.status} subtitle="Not available" />
    </div>
  );
}

function Caption({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="aperture:absolute aperture:inset-x-0 aperture:bottom-0 aperture:grid aperture:bg-linear-to-t aperture:from-black/85 aperture:via-black/55 aperture:to-transparent aperture:px-2 aperture:pt-4 aperture:pb-1.5 aperture:text-white">
      <span className="aperture:truncate aperture:text-[0.7rem] aperture:font-medium">{title}</span>
      <span className="aperture:truncate aperture:text-[0.62rem] aperture:text-white/70">
        {subtitle}
      </span>
    </div>
  );
}
