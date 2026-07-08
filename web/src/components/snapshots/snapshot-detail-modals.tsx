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
import { DeletedBadge } from "#/components/resources/status-badge.tsx";
import { TagBadges } from "#/components/resources/tag-badges.tsx";
import { ScrollArea } from "#/components/ui/scroll-area.tsx";
import type { Snapshot } from "#/lib/api/schemas.ts";

export type SnapshotDetailSection = "details" | "events";

type SnapshotDetailModalsProps = {
  snapshot: Snapshot | null;
  section: SnapshotDetailSection | null;
  onSectionChange: (section: SnapshotDetailSection | null) => void;
};

export function SnapshotDetailModals({
  snapshot,
  section,
  onSectionChange,
}: SnapshotDetailModalsProps) {
  const [detailsContent, setDetailsContent] = useState<Snapshot | null>(null);
  const [eventsContent, setEventsContent] = useState<Snapshot | null>(null);

  useEffect(() => {
    if (!snapshot) {
      return;
    }

    if (section === "details") {
      setDetailsContent(snapshot);
      return;
    }

    if (section === "events") {
      setEventsContent(snapshot);
    }
  }, [section, snapshot]);

  function closeIfNeeded(open: boolean) {
    if (!open) {
      onSectionChange(null);
    }
  }

  const detailsSnapshot = section === "details" && snapshot ? snapshot : detailsContent;
  const eventsSnapshot = section === "events" && snapshot ? snapshot : eventsContent;

  return (
    <>
      <Dialog open={section === "details" && snapshot !== null} onOpenChange={closeIfNeeded}>
        <DialogContent className="flex max-h-[min(80vh,720px)] flex-col overflow-hidden sm:max-w-2xl">
          {detailsSnapshot ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  {detailsSnapshot.name}
                  <DeletedBadge deletedAt={detailsSnapshot.deletedAt} />
                </DialogTitle>
                <DialogDescription>Snapshot details</DialogDescription>
              </DialogHeader>
              <ScrollArea className="min-h-0 flex-1">
                <MetadataGrid
                  items={[
                    { label: "ID", value: detailsSnapshot.id },
                    { label: "Description", value: detailsSnapshot.description ?? "—" },
                    { label: "Tenant", value: detailsSnapshot.tenantId },
                    { label: "Parent", value: detailsSnapshot.parentSnapshotId ?? "—" },
                    {
                      label: "Promoted from",
                      value: detailsSnapshot.promotedFromSessionId ?? "—",
                    },
                    { label: "Created", value: metadataTimestamp(detailsSnapshot.createdAt) },
                    { label: "Expires", value: metadataTimestamp(detailsSnapshot.expiresAt) },
                    { label: "Deleted", value: metadataTimestamp(detailsSnapshot.deletedAt) },
                    { label: "Tags", value: <TagBadges tags={detailsSnapshot.tags} max={10} /> },
                  ]}
                />
              </ScrollArea>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={section === "events" && snapshot !== null} onOpenChange={closeIfNeeded}>
        <DialogContent className="flex max-h-[min(80vh,720px)] flex-col overflow-hidden sm:max-w-3xl">
          {eventsSnapshot ? (
            <>
              <DialogHeader>
                <DialogTitle>{eventsSnapshot.name}</DialogTitle>
                <DialogDescription>Snapshot events</DialogDescription>
              </DialogHeader>
              <ScrollArea className="min-h-0 flex-1">
                <EventsPanel resourceType="snapshot" resourceId={eventsSnapshot.id} />
              </ScrollArea>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
