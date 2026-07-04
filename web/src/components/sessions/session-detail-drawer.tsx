import { Sheet, SheetContent, SheetHeader, SheetTitle } from "#/components/ui/sheet.tsx";
import { Separator } from "#/components/ui/separator.tsx";
import { EventsPanel } from "#/components/resources/events-panel.tsx";
import { MetadataGrid, metadataTimestamp } from "#/components/resources/metadata-grid.tsx";
import { SessionStatusBadge } from "#/components/resources/status-badge.tsx";
import { TagBadges } from "#/components/resources/tag-badges.tsx";
import type { Session } from "#/lib/api/schemas.ts";
import { truncateId } from "#/lib/format.ts";
import {
  ConnectionPanel,
  type TransientCdpCredentials,
} from "#/components/sessions/connection-panel.tsx";

type SessionDetailDrawerProps = {
  session: Session | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transientCdp: TransientCdpCredentials;
  onTransientCdpChange: (credentials: TransientCdpCredentials) => void;
};

export function SessionDetailDrawer({
  session,
  open,
  onOpenChange,
  transientCdp,
  onTransientCdpChange,
}: SessionDetailDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        {session ? (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <span className="font-mono text-sm">{truncateId(session.id, 12)}</span>
                <SessionStatusBadge status={session.status} />
              </SheetTitle>
            </SheetHeader>
            <div className="space-y-4 px-4 pb-4">
              <MetadataGrid
                items={[
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
              <Separator />
              <ConnectionPanel
                session={session}
                transientCdp={transientCdp}
                onRotate={(credentials) => onTransientCdpChange(credentials)}
              />
              <Separator />
              <EventsPanel resourceType="session" resourceId={session.id} />
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
