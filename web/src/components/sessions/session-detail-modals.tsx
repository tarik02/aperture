import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import { useEffect, useState } from "react";
import { EventsPanel } from "#/components/resources/events-panel.tsx";
import { MetadataGrid, metadataTimestamp } from "#/components/resources/metadata-grid.tsx";
import { SessionStatusBadge } from "#/components/resources/status-badge.tsx";
import { TagBadges } from "#/components/resources/tag-badges.tsx";
import { ScrollArea } from "#/components/ui/scroll-area.tsx";
import type { Session } from "#/lib/api/schemas.ts";
import {
  ConnectionPanel,
  type TransientCdpCredentials,
} from "#/components/sessions/connection-panel.tsx";

export type SessionDetailSection = "details" | "connection" | "events";

type SessionDetailModalsProps = {
  session: Session | null;
  section: SessionDetailSection | null;
  onSectionChange: (section: SessionDetailSection | null) => void;
  transientCdp: TransientCdpCredentials;
  onTransientCdpChange: (credentials: TransientCdpCredentials) => void;
};

type ConnectionContent = {
  session: Session;
  transientCdp: TransientCdpCredentials;
};

export function SessionDetailModals({
  session,
  section,
  onSectionChange,
  transientCdp,
  onTransientCdpChange,
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
      setConnectionContent({ session, transientCdp });
      return;
    }

    if (section === "events") {
      setEventsContent(session);
    }
  }, [section, session, transientCdp]);

  function closeIfNeeded(open: boolean) {
    if (!open) {
      onSectionChange(null);
    }
  }

  const detailsSession = section === "details" && session ? session : detailsContent;
  const connection =
    section === "connection" && session ? { session, transientCdp } : connectionContent;
  const eventsSession = section === "events" && session ? session : eventsContent;

  return (
    <>
      <Dialog open={section === "details" && session !== null} onOpenChange={closeIfNeeded}>
        <DialogContent className="flex max-h-[min(80vh,720px)] flex-col overflow-hidden sm:max-w-2xl">
          {detailsSession ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  Session details
                  <SessionStatusBadge status={detailsSession.status} />
                </DialogTitle>
                <DialogDescription className="break-all font-mono">
                  {detailsSession.id}
                </DialogDescription>
              </DialogHeader>
              <ScrollArea className="min-h-0 flex-1">
                <MetadataGrid
                  items={[
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
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={section === "connection" && session !== null} onOpenChange={closeIfNeeded}>
        <DialogContent className="sm:max-w-lg">
          {connection ? (
            <>
              <DialogHeader>
                <DialogTitle>Connection</DialogTitle>
                <DialogDescription className="break-all font-mono">
                  {connection.session.id}
                </DialogDescription>
              </DialogHeader>
              <ConnectionPanel
                session={connection.session}
                transientCdp={connection.transientCdp}
                onRotate={(credentials) => onTransientCdpChange(credentials)}
              />
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={section === "events" && session !== null} onOpenChange={closeIfNeeded}>
        <DialogContent className="flex max-h-[min(80vh,720px)] flex-col overflow-hidden sm:max-w-3xl">
          {eventsSession ? (
            <>
              <DialogHeader>
                <DialogTitle>Session events</DialogTitle>
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
