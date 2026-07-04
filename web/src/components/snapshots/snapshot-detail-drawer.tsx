import { Sheet, SheetContent, SheetHeader, SheetTitle } from "#/components/ui/sheet.tsx";
import { Separator } from "#/components/ui/separator.tsx";
import { EventsPanel } from "#/components/resources/events-panel.tsx";
import { MetadataGrid, metadataTimestamp } from "#/components/resources/metadata-grid.tsx";
import { DeletedBadge } from "#/components/resources/status-badge.tsx";
import { TagBadges } from "#/components/resources/tag-badges.tsx";
import type { Snapshot } from "#/lib/api/schemas.ts";

type SnapshotDetailDrawerProps = {
  snapshot: Snapshot | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function SnapshotDetailDrawer({ snapshot, open, onOpenChange }: SnapshotDetailDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        {snapshot ? (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <span>{snapshot.name}</span>
                <DeletedBadge deletedAt={snapshot.deletedAt} />
              </SheetTitle>
            </SheetHeader>
            <div className="space-y-4 px-4 pb-4">
              <MetadataGrid
                items={[
                  { label: "ID", value: snapshot.id },
                  { label: "Tenant", value: snapshot.tenantId },
                  { label: "Parent", value: snapshot.parentSnapshotId ?? "—" },
                  { label: "Promoted from", value: snapshot.promotedFromSessionId ?? "—" },
                  { label: "Created", value: metadataTimestamp(snapshot.createdAt) },
                  { label: "Expires", value: metadataTimestamp(snapshot.expiresAt) },
                  { label: "Deleted", value: metadataTimestamp(snapshot.deletedAt) },
                  { label: "Tags", value: <TagBadges tags={snapshot.tags} max={10} /> },
                ]}
              />
              <Separator />
              <EventsPanel resourceType="snapshot" resourceId={snapshot.id} />
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
