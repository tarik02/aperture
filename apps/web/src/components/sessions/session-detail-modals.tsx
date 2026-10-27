import { useTenantName } from "#/hooks/use-tenant-name.ts";
import { Clock3, Info, PlugZap, Tags } from "lucide-react";
import { useEffect, useState } from "react";
import { DetailList, DetailRow, DetailSection } from "#/components/details/detail-list.tsx";
import { reference, relativeTime } from "#/components/details/detail-values.tsx";
import { IdChip } from "#/components/details/id-chip.tsx";
import { EventsPanel } from "#/components/resources/events-panel.tsx";
import { SessionStatusBadge } from "#/components/resources/status-badge.tsx";
import { TagBadges } from "#/components/resources/tag-badges.tsx";
import {
  entriesToTags,
  TagEditor,
  tagsToEntries,
  type TagEntry,
} from "@aperture-browser/ui/components/tag-editor";
import { ConnectionPanel } from "#/components/sessions/connection-panel.tsx";
import { Button } from "@aperture-browser/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import { ScrollArea } from "@aperture-browser/ui/components/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@aperture-browser/ui/components/tabs";
import type { Session } from "@aperture-browser/api-client";

export type SessionDetailSection = "details" | "connection" | "events" | "tags";

type SessionDetailModalsProps = {
  session: Session | null;
  section: SessionDetailSection | null;
  onSectionChange: (section: SessionDetailSection | null) => void;
  onSessionChange?: (session: Session) => void;
  actions?: SessionDetailActions;
};

// Lifecycle callbacks are accepted for compatibility with callers; the modal is
// informational and those actions live in the session menu. Only tags are
// edited here.
type SessionDetailActions = {
  canWrite: boolean;
  canSaveSnapshot: boolean;
  deletePending: boolean;
  reopenPending: boolean;
  suspendPending: boolean;
  tagsPending: boolean;
  rotatePending: boolean;
  copySharePending: boolean;
  onDelete: (session: Session) => void;
  onSaveTags: (session: Session, tags: Record<string, string>) => Promise<Session>;
  onSaveToSnapshot: (session: Session) => void;
  onReopen: (session: Session) => void;
  onSuspend: (session: Session) => void;
  onRotate: (session: Session) => void;
  onCopyShareUrl: (session: Session) => void;
};

type RetainedSessionDetailContent = {
  session: Session;
  section: SessionDetailSection;
};

const tabTriggerClassName =
  "aperture:h-full aperture:flex-none aperture:rounded-none aperture:px-2 aperture:text-[13px]";

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
      <DialogContent className="aperture:gap-0 aperture:overflow-hidden aperture:p-0 aperture:sm:max-w-2xl">
        {displayedSession ? (
          <>
            <DialogHeader className="aperture:gap-1.5 aperture:px-4 aperture:pt-4 aperture:pr-12 aperture:pb-3">
              <DialogTitle className="aperture:flex aperture:min-w-0 aperture:items-center aperture:gap-2">
                <span className="aperture:min-w-0 aperture:truncate">
                  {displayedSession.label ?? "Session"}
                </span>
                <SessionStatusBadge status={displayedSession.status} />
                <IdChip value={displayedSession.id} label="session ID" />
              </DialogTitle>
            </DialogHeader>
            <Tabs
              value={displayedSection}
              onValueChange={(value) => {
                if (isSessionDetailSection(value)) {
                  onSectionChange(value);
                }
              }}
              className="aperture:min-h-0 aperture:gap-0"
            >
              <TabsList
                variant="line"
                className="aperture:h-9 aperture:w-full aperture:shrink-0 aperture:justify-start aperture:gap-0.5 aperture:border-y aperture:px-3 aperture:py-0"
              >
                <TabsTrigger value="details" className={tabTriggerClassName}>
                  <Info data-icon="inline-start" />
                  Details
                </TabsTrigger>
                <TabsTrigger value="connection" className={tabTriggerClassName}>
                  <PlugZap data-icon="inline-start" />
                  Connection
                </TabsTrigger>
                <TabsTrigger value="events" className={tabTriggerClassName}>
                  <Clock3 data-icon="inline-start" />
                  Events
                </TabsTrigger>
                <TabsTrigger value="tags" className={tabTriggerClassName}>
                  <Tags data-icon="inline-start" />
                  Tags
                </TabsTrigger>
              </TabsList>
              <div className="aperture:h-[min(32rem,70svh)] aperture:min-h-0 aperture:overflow-hidden aperture:p-4">
                <TabsContent value="details" className="aperture:h-full aperture:min-h-0">
                  <ScrollArea
                    className="aperture:h-full aperture:min-h-0"
                    viewportClassName="aperture:data-[has-overflow-y]:pr-3"
                  >
                    <SessionMetadata session={displayedSession} />
                  </ScrollArea>
                </TabsContent>
                <TabsContent value="connection" className="aperture:h-full aperture:min-h-0">
                  <ConnectionPanel
                    session={displayedSession}
                    onRotate={onSessionChange}
                    modalFooter
                  />
                </TabsContent>
                <TabsContent value="events" className="aperture:h-full aperture:min-h-0">
                  <EventsPanel
                    resourceType="session"
                    resourceId={displayedSession.id}
                    className="aperture:h-full"
                  />
                </TabsContent>
                <TabsContent value="tags" className="aperture:h-full aperture:min-h-0">
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
  const tenantName = useTenantName(session.tenantId);
  const tagCount = Object.keys(session.tags ?? {}).length;
  return (
    <DetailList>
      <DetailSection title="Browser">
        <DetailRow label="Channel">{session.browserChannel}</DetailRow>
        <DetailRow label="Snapshot">{session.baseSnapshotName}</DetailRow>
        <DetailRow label="Tenant">
          {reference(session.tenantId ? { id: session.tenantId, name: tenantName } : null)}
        </DetailRow>
        <DetailRow label="Tags">
          {tagCount > 0 ? <TagBadges tags={session.tags} max={6} /> : null}
        </DetailRow>
      </DetailSection>
      <DetailSection title="Lifecycle">
        <DetailRow label="Created">{relativeTime(session.createdAt)}</DetailRow>
        <DetailRow label="Started">{relativeTime(session.startedAt)}</DetailRow>
        <DetailRow label="Stopped">{relativeTime(session.stoppedAt)}</DetailRow>
        <DetailRow label="Expires">
          {relativeTime(session.expiresAt) ?? (session.deletedAt ? null : "Never")}
        </DetailRow>
        <DetailRow label="Deleted">{relativeTime(session.deletedAt)}</DetailRow>
      </DetailSection>
    </DetailList>
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
    if (Object.keys(session.tags ?? {}).length === 0) {
      return <p className="aperture:text-sm aperture:text-muted-foreground">No tags.</p>;
    }
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
      className="aperture:flex aperture:h-full aperture:min-h-0 aperture:flex-col aperture:gap-3"
      onSubmit={(event) => void handleSubmit(event)}
    >
      <ScrollArea
        className="aperture:min-h-0 aperture:flex-1"
        viewportClassName="aperture:data-[has-overflow-y]:pr-3"
      >
        <TagEditor
          entries={entries}
          onChange={setEntries}
          disabled={actions.tagsPending}
          hideLabel
        />
      </ScrollArea>
      <div className="aperture:-mx-4 aperture:-mb-4 aperture:flex aperture:shrink-0 aperture:justify-end aperture:border-t aperture:bg-muted/50 aperture:px-4 aperture:py-3">
        <Button type="submit" size="sm" disabled={actions.tagsPending}>
          Save tags
        </Button>
      </div>
    </form>
  );
}
