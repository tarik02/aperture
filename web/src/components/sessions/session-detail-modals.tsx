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
import {
  entriesToTags,
  TagEditor,
  tagsToEntries,
  type TagEntry,
} from "#/components/resources/tag-editor.tsx";
import { ConnectionPanel } from "#/components/sessions/connection-panel.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "#/components/ui/dialog.tsx";
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

export type SessionDetailSection = "details" | "connection" | "events" | "tags";

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
  tagsPending: boolean;
  rotatePending: boolean;
  copySharePending: boolean;
  onDelete: (session: Session) => void;
  onSaveTags: (session: Session, tags: Record<string, string>) => Promise<Session>;
  onPromote: (session: Session) => void;
  onReopen: (session: Session) => void;
  onSuspend: (session: Session) => void;
  onRotate: (session: Session) => void;
  onCopyShareUrl: (session: Session) => void;
};

type RetainedSessionDetailContent = {
  session: Session;
  section: SessionDetailSection;
};

export function SessionDetailModals({
  session,
  section,
  onSectionChange,
  onSessionChange,
  actions,
}: SessionDetailModalsProps) {
  const [content, setContent] = useState<RetainedSessionDetailContent | null>(null);

  useEffect(() => {
    if (session && section) {
      setContent({ session, section });
    }
  }, [section, session]);

  function closeIfNeeded(open: boolean) {
    if (!open) {
      onSectionChange(null);
    }
  }

  const displayedSession = session ?? content?.session;
  const displayedSection = section ?? content?.section ?? "details";

  return (
    <Dialog open={section !== null && session !== null} onOpenChange={closeIfNeeded}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-3xl">
        {displayedSession ? (
          <>
            <DialogHeader className="gap-0 px-4 pt-4 pr-12 pb-3">
              <DialogTitle className="flex items-center gap-2">
                {displayedSession.label ?? "Session details"}
                <SessionStatusBadge status={displayedSession.status} />
              </DialogTitle>
            </DialogHeader>
            <Tabs
              value={displayedSection}
              onValueChange={(value) => {
                if (isSessionDetailSection(value)) {
                  onSectionChange(value);
                }
              }}
              className="min-h-0 gap-0"
            >
              <TabsList
                variant="line"
                className="h-10 w-full shrink-0 justify-start border-y px-4 py-0"
              >
                <TabsTrigger value="details" className="h-full flex-none rounded-none px-2.5">
                  <Info data-icon="inline-start" />
                  Details
                </TabsTrigger>
                <TabsTrigger value="connection" className="h-full flex-none rounded-none px-2.5">
                  <PlugZap data-icon="inline-start" />
                  Connection
                </TabsTrigger>
                <TabsTrigger value="events" className="h-full flex-none rounded-none px-2.5">
                  <Clock3 data-icon="inline-start" />
                  Events
                </TabsTrigger>
                <TabsTrigger value="tags" className="h-full flex-none rounded-none px-2.5">
                  <Tags data-icon="inline-start" />
                  Tags
                </TabsTrigger>
              </TabsList>
              <div className="h-[min(50svh,20rem)] min-h-0 overflow-hidden p-4">
                <TabsContent value="details" className="h-full min-h-0">
                  {actions ? (
                    <div className="grid h-full min-h-0 gap-4 sm:grid-cols-[minmax(0,1fr)_11rem]">
                      <ScrollArea className="h-full min-h-0" viewportClassName="pr-3">
                        <SessionMetadata session={displayedSession} />
                      </ScrollArea>
                      <SessionDetailActionBar session={displayedSession} actions={actions} />
                    </div>
                  ) : (
                    <ScrollArea className="h-full min-h-0" viewportClassName="pr-3">
                      <SessionMetadata session={displayedSession} />
                    </ScrollArea>
                  )}
                </TabsContent>
                <TabsContent value="connection" className="h-full min-h-0">
                  <ConnectionPanel
                    session={displayedSession}
                    onRotate={onSessionChange}
                    modalFooter
                  />
                </TabsContent>
                <TabsContent value="events" className="h-full min-h-0">
                  <EventsPanel
                    resourceType="session"
                    resourceId={displayedSession.id}
                    className="h-full"
                  />
                </TabsContent>
                <TabsContent value="tags" className="h-full min-h-0">
                  <SessionTagsPanel
                    key={displayedSession.id}
                    session={displayedSession}
                    actions={actions}
                    onSessionChange={onSessionChange}
                  />
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
  return value === "details" || value === "connection" || value === "events" || value === "tags";
}

function SessionMetadata({ session }: { session: Session }) {
  return (
    <MetadataGrid
      items={[
        { kind: "text", label: "Label", value: session.label ?? "—" },
        { kind: "identifier", label: "ID", value: session.id },
        { kind: "identifier", label: "Tenant", value: session.tenantId },
        { kind: "text", label: "Channel", value: session.browser.channel },
        { kind: "text", label: "Mode", value: session.browser.mode },
        { kind: "text", label: "Snapshot", value: session.baseSnapshotName ?? "—" },
        { kind: "text", label: "Created", value: metadataTimestamp(session.createdAt) },
        { kind: "text", label: "Started", value: metadataTimestamp(session.startedAt) },
        { kind: "text", label: "Stopped", value: metadataTimestamp(session.stoppedAt) },
        { kind: "text", label: "Expires", value: metadataTimestamp(session.expiresAt) },
        { kind: "text", label: "Deleted", value: metadataTimestamp(session.deletedAt) },
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
    <div className="flex flex-col gap-2 sm:border-l sm:border-border sm:pl-4">
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

type SessionTagsPanelProps = {
  session: Session;
  actions?: SessionDetailActions;
  onSessionChange?: (session: Session) => void;
};

function SessionTagsPanel({ session, actions, onSessionChange }: SessionTagsPanelProps) {
  const [entries, setEntries] = useState<TagEntry[]>(() => tagsToEntries(session.tags ?? {}));

  if (!actions?.canWrite) {
    return <TagBadges tags={session.tags} max={100} />;
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!actions) {
      return;
    }

    const updatedSession = await actions.onSaveTags(session, entriesToTags(entries));
    onSessionChange?.(updatedSession);
  }

  return (
    <form
      className="flex h-full min-h-0 flex-col gap-3"
      onSubmit={(event) => void handleSubmit(event)}
    >
      <ScrollArea className="min-h-0 flex-1" viewportClassName="data-[has-overflow-y]:pr-3">
        <TagEditor
          entries={entries}
          onChange={setEntries}
          disabled={actions.tagsPending}
          hideLabel
        />
      </ScrollArea>
      <div className="flex shrink-0 justify-end border-t pt-3">
        <Button type="submit" size="sm" disabled={actions.tagsPending}>
          Save tags
        </Button>
      </div>
    </form>
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
        <DropdownMenuContent align="end" className="min-w-48">
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
