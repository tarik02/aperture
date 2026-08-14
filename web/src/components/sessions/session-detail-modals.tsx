import { Link } from "@tanstack/react-router";
import {
  AppWindow,
  Cable,
  ChevronDown,
  Clock3,
  Copy,
  Info,
  KeyRound,
  Pause,
  PlugZap,
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
import { ConnectionPanel } from "#/components/sessions/connection-panel.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import { ScrollArea } from "#/components/ui/scroll-area.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs.tsx";
import type { Session } from "#/lib/api/schemas.ts";

export type SessionDetailSection = "details" | "connection" | "events";

type SessionDetailModalsProps = {
  session: Session | null;
  section: SessionDetailSection | null;
  onSectionChange: (section: SessionDetailSection | null) => void;
  onSessionChange?: (session: Session) => void;
  actions?: SessionDetailActions;
};

type SessionDetailActions = {
  canWrite: boolean;
  canPromote: boolean;
  deletePending: boolean;
  reopenPending: boolean;
  suspendPending: boolean;
  rotatePending: boolean;
  copySharePending: boolean;
  onDelete: (session: Session) => void;
  onEditTags: (session: Session) => void;
  onPromote: (session: Session) => void;
  onReopen: (session: Session) => void;
  onSuspend: (session: Session) => void;
  onRotate: (session: Session) => void;
  onCopyShareUrl: (session: Session) => void;
};

export function SessionDetailModals({
  session,
  section,
  onSectionChange,
  onSessionChange,
  actions,
}: SessionDetailModalsProps) {
  const [content, setContent] = useState<Session | null>(null);

  useEffect(() => {
    if (session) {
      setContent(session);
    }
  }, [session]);

  function closeIfNeeded(open: boolean) {
    if (!open) {
      onSectionChange(null);
    }
  }

  const displayedSession = session ?? content;

  return (
    <Dialog open={section !== null && session !== null} onOpenChange={closeIfNeeded}>
      <DialogContent className="flex h-[min(80vh,720px)] flex-col overflow-hidden sm:max-w-4xl">
        {displayedSession ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {displayedSession.label ?? "Session details"}
                <SessionStatusBadge status={displayedSession.status} />
              </DialogTitle>
              <DialogDescription className="break-all font-mono">
                {displayedSession.id}
              </DialogDescription>
            </DialogHeader>
            <Tabs
              value={section ?? "details"}
              onValueChange={(value) => {
                if (isSessionDetailSection(value)) {
                  onSectionChange(value);
                }
              }}
              className="min-h-0 flex-1"
            >
              <TabsList className="w-full sm:w-fit">
                <TabsTrigger value="details">
                  <Info data-icon="inline-start" />
                  Details
                </TabsTrigger>
                <TabsTrigger value="connection">
                  <PlugZap data-icon="inline-start" />
                  Connection
                </TabsTrigger>
                <TabsTrigger value="events">
                  <Clock3 data-icon="inline-start" />
                  Events
                </TabsTrigger>
              </TabsList>
              <div className="min-h-0 flex-1">
                <TabsContent value="details" className="h-full min-h-0">
                  {actions ? (
                    <div className="grid h-full min-h-0 gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
                      <ScrollArea className="min-h-0">
                        <SessionMetadata session={displayedSession} />
                      </ScrollArea>
                      <SessionDetailActionBar session={displayedSession} actions={actions} />
                    </div>
                  ) : (
                    <ScrollArea className="h-full">
                      <SessionMetadata session={displayedSession} />
                    </ScrollArea>
                  )}
                </TabsContent>
                <TabsContent value="connection" className="h-full min-h-0">
                  <ScrollArea className="h-full">
                    <ConnectionPanel session={displayedSession} onRotate={onSessionChange} />
                  </ScrollArea>
                </TabsContent>
                <TabsContent value="events" className="h-full min-h-0">
                  <ScrollArea className="h-full">
                    <EventsPanel resourceType="session" resourceId={displayedSession.id} />
                  </ScrollArea>
                </TabsContent>
              </div>
            </Tabs>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function isSessionDetailSection(value: string): value is SessionDetailSection {
  return value === "details" || value === "connection" || value === "events";
}

function SessionMetadata({ session }: { session: Session }) {
  return (
    <MetadataGrid
      items={[
        { label: "Label", value: session.label ?? "—" },
        { label: "ID", value: session.id },
        { label: "Tenant", value: session.tenantId },
        { label: "Channel", value: session.browserChannel ?? "—" },
        { label: "Snapshot", value: session.baseSnapshotName ?? "—" },
        { label: "Created", value: metadataTimestamp(session.createdAt) },
        { label: "Started", value: metadataTimestamp(session.startedAt) },
        { label: "Stopped", value: metadataTimestamp(session.stoppedAt) },
        { label: "Expires", value: metadataTimestamp(session.expiresAt) },
        { label: "Deleted", value: metadataTimestamp(session.deletedAt) },
        { label: "Tags", value: <TagBadges tags={session.tags} max={10} /> },
      ]}
    />
  );
}

type SessionDetailActionBarProps = {
  session: Session;
  actions: SessionDetailActions;
};

function SessionDetailActionBar({ session, actions }: SessionDetailActionBarProps) {
  const canOpen = session.status === "running" || session.status === "suspended";
  const canReopen =
    actions.canWrite && (session.status === "deleted" || session.status === "failed");
  const canPromote =
    actions.canPromote &&
    (session.status === "running" ||
      session.status === "suspended" ||
      session.status === "deleted" ||
      session.status === "failed");
  const canSuspend = actions.canWrite && session.status === "running";
  const canRotate =
    actions.canWrite && (session.status === "running" || session.status === "suspended");

  return (
    <div className="flex flex-col justify-end gap-2 sm:border-l sm:border-border sm:pl-4">
      <OpenSessionButton sessionId={session.id} disabled={!canOpen} />
      {actions.canWrite ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => actions.onCopyShareUrl(session)}
          disabled={actions.copySharePending}
        >
          <Copy data-icon="inline-start" />
          Copy share URL
        </Button>
      ) : null}
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
            Rotate token
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
        nativeButton={disabled}
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
              aria-label="Open session options"
              disabled={disabled}
            />
          }
        >
          <ChevronDown />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          <DropdownMenuGroup>
            <DropdownMenuItem
              render={
                <Link
                  to="/-/sessions/$sessionId"
                  params={{ sessionId }}
                  search={{ media: "cdp" }}
                />
              }
            >
              <Cable />
              CDP fallback
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
