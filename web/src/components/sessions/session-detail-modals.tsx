import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import { Link } from "@tanstack/react-router";
import {
  AppWindow,
  ChevronDown,
  Clock,
  ExternalLink,
  KeyRound,
  Pause,
  RotateCcw,
  Tags,
  Trash2,
  Upload,
} from "lucide-react";
import { useEffect, useState } from "react";
import { EventsPanel } from "#/components/resources/events-panel.tsx";
import { MetadataGrid, metadataTimestamp } from "#/components/resources/metadata-grid.tsx";
import { SessionStatusBadge } from "#/components/resources/status-badge.tsx";
import { TagBadges } from "#/components/resources/tag-badges.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import { ScrollArea } from "#/components/ui/scroll-area.tsx";
import type { Session } from "#/lib/api/schemas.ts";
import { ConnectionPanel } from "#/components/sessions/connection-panel.tsx";

export type SessionDetailSection = "details" | "connection" | "events";

type SessionDetailModalsProps = {
  session: Session | null;
  section: SessionDetailSection | null;
  onSectionChange: (section: SessionDetailSection | null) => void;
  onSessionChange: (session: Session) => void;
  actions: SessionDetailActions;
};

type SessionDetailActions = {
  canWrite: boolean;
  canPromote: boolean;
  deletePending: boolean;
  reopenPending: boolean;
  suspendPending: boolean;
  rotatePending: boolean;
  onDelete: (session: Session) => void;
  onEditTags: (session: Session) => void;
  onPromote: (session: Session) => void;
  onReopen: (session: Session) => void;
  onSuspend: (session: Session) => void;
  onRotate: (session: Session) => void;
};

type ConnectionContent = {
  session: Session;
};

export function SessionDetailModals({
  session,
  section,
  onSectionChange,
  onSessionChange,
  actions,
}: SessionDetailModalsProps) {
  const [detailsContent, setDetailsContent] = useState<Session | null>(null);
  const [connectionContent, setConnectionContent] = useState<ConnectionContent | null>(null);
  const [eventsContent, setEventsContent] = useState<Session | null>(null);

  useEffect(() => {
    if (!session) {
      return;
    }

    if (section === "details") {
      setDetailsContent(session);
      return;
    }

    if (section === "connection") {
      setConnectionContent({ session });
      return;
    }

    if (section === "events") {
      setEventsContent(session);
    }
  }, [section, session]);

  function closeIfNeeded(open: boolean) {
    if (!open) {
      onSectionChange(null);
    }
  }

  const detailsSession = section === "details" && session ? session : detailsContent;
  const connection = section === "connection" && session ? { session } : connectionContent;
  const eventsSession = section === "events" && session ? session : eventsContent;

  return (
    <>
      <Dialog open={section === "details" && session !== null} onOpenChange={closeIfNeeded}>
        <DialogContent className="flex max-h-[min(80vh,720px)] flex-col overflow-hidden sm:max-w-4xl">
          {detailsSession ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  {detailsSession.label ?? "Session details"}
                  <SessionStatusBadge status={detailsSession.status} />
                </DialogTitle>
                <DialogDescription className="break-all font-mono">
                  {detailsSession.id}
                </DialogDescription>
              </DialogHeader>
              <div className="grid min-h-0 flex-1 gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
                <ScrollArea className="min-h-0">
                  <MetadataGrid
                    items={[
                      { label: "Label", value: detailsSession.label ?? "—" },
                      { label: "ID", value: detailsSession.id },
                      { label: "Tenant", value: detailsSession.tenantId },
                      { label: "Channel", value: detailsSession.browserChannel ?? "—" },
                      { label: "Snapshot", value: detailsSession.baseSnapshotName ?? "—" },
                      { label: "Created", value: metadataTimestamp(detailsSession.createdAt) },
                      { label: "Started", value: metadataTimestamp(detailsSession.startedAt) },
                      { label: "Stopped", value: metadataTimestamp(detailsSession.stoppedAt) },
                      { label: "Expires", value: metadataTimestamp(detailsSession.expiresAt) },
                      { label: "Deleted", value: metadataTimestamp(detailsSession.deletedAt) },
                      { label: "Tags", value: <TagBadges tags={detailsSession.tags} max={10} /> },
                    ]}
                  />
                </ScrollArea>
                <SessionDetailActionBar
                  session={detailsSession}
                  actions={actions}
                  onConnection={() => onSectionChange("connection")}
                  onEvents={() => onSectionChange("events")}
                />
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={section === "connection" && session !== null} onOpenChange={closeIfNeeded}>
        <DialogContent className="sm:max-w-lg">
          {connection ? (
            <>
              <DialogHeader>
                <DialogTitle>{connection.session.label ?? "Connection"}</DialogTitle>
                <DialogDescription className="break-all font-mono">
                  {connection.session.id}
                </DialogDescription>
              </DialogHeader>
              <ConnectionPanel session={connection.session} onRotate={onSessionChange} />
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={section === "events" && session !== null} onOpenChange={closeIfNeeded}>
        <DialogContent className="flex max-h-[min(80vh,720px)] flex-col overflow-hidden sm:max-w-3xl">
          {eventsSession ? (
            <>
              <DialogHeader>
                <DialogTitle>{eventsSession.label ?? "Session events"}</DialogTitle>
                <DialogDescription className="break-all font-mono">
                  {eventsSession.id}
                </DialogDescription>
              </DialogHeader>
              <ScrollArea className="min-h-0 flex-1">
                <EventsPanel resourceType="session" resourceId={eventsSession.id} />
              </ScrollArea>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

type SessionDetailActionBarProps = {
  session: Session;
  actions: SessionDetailActions;
  onConnection: () => void;
  onEvents: () => void;
};

function SessionDetailActionBar({
  session,
  actions,
  onConnection,
  onEvents,
}: SessionDetailActionBarProps) {
  const canOpen = session.status === "running" || session.status === "suspended";
  const canReopen =
    actions.canWrite && (session.status === "deleted" || session.status === "failed");
  const canPromote =
    actions.canPromote &&
    (session.status === "suspended" || session.status === "deleted" || session.status === "failed");
  const canSuspend = actions.canWrite && session.status === "running";
  const canRotate =
    actions.canWrite && (session.status === "running" || session.status === "suspended");

  return (
    <div className="flex flex-col justify-end gap-2 sm:border-l sm:border-border sm:pl-4">
      <OpenSessionButton sessionId={session.id} disabled={!canOpen} />
      <Button type="button" variant="outline" size="sm" onClick={onConnection}>
        <ExternalLink data-icon="inline-start" />
        Connection
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={onEvents}>
        <Clock data-icon="inline-start" />
        Events
      </Button>
      {actions.canWrite ? (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => actions.onEditTags(session)}
          >
            <Tags data-icon="inline-start" />
            Tags
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => actions.onRotate(session)}
            disabled={!canRotate || actions.rotatePending}
          >
            <KeyRound data-icon="inline-start" />
            Rotate CDP
          </Button>
          {canSuspend ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => actions.onSuspend(session)}
              disabled={actions.suspendPending}
            >
              <Pause data-icon="inline-start" />
              Suspend
            </Button>
          ) : null}
          {canReopen ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => actions.onReopen(session)}
              disabled={actions.reopenPending}
            >
              <RotateCcw data-icon="inline-start" />
              Reopen
            </Button>
          ) : null}
          {canPromote ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => actions.onPromote(session)}
            >
              <Upload data-icon="inline-start" />
              Promote
            </Button>
          ) : null}
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="mt-2"
            onClick={() => actions.onDelete(session)}
            disabled={actions.deletePending}
          >
            <Trash2 data-icon="inline-start" />
            Delete
          </Button>
        </>
      ) : null}
    </div>
  );
}

type OpenSessionButtonProps = {
  sessionId: string;
  disabled: boolean;
};

function OpenSessionButton({ sessionId, disabled }: OpenSessionButtonProps) {
  return (
    <div className="flex w-full">
      <Button
        type="button"
        size="sm"
        className="flex-1 rounded-r-none"
        disabled={disabled}
        render={disabled ? undefined : <Link to="/-/sessions/$sessionId" params={{ sessionId }} />}
      >
        <AppWindow data-icon="inline-start" />
        Open
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              size="icon-sm"
              className="-ml-px rounded-l-none border-l-primary-foreground/30"
              disabled={disabled}
            />
          }
        >
          <ChevronDown />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          <DropdownMenuItem
            render={
              <Link to="/-/sessions/$sessionId" params={{ sessionId }} search={{ media: "cdp" }} />
            }
          >
            CDP fallback
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
