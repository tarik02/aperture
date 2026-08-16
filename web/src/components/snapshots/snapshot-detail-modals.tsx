import { AppWindow, Clock3, Info } from "lucide-react";
import { useEffect, useState } from "react";
import { EventsPanel } from "#/components/resources/events-panel.tsx";
import { MetadataGrid, metadataTimestamp } from "#/components/resources/metadata-grid.tsx";
import { DeletedBadge } from "#/components/resources/status-badge.tsx";
import { TagBadges } from "#/components/resources/tag-badges.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import { ScrollArea } from "#/components/ui/scroll-area.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs.tsx";
import type { Snapshot } from "#/lib/api/schemas.ts";

export type SnapshotDetailSection = "details" | "events";

type SnapshotDetailModalsProps = {
  snapshot: Snapshot | null;
  section: SnapshotDetailSection | null;
  onSectionChange: (section: SnapshotDetailSection | null) => void;
  canCreateSession: boolean;
  onCreateSession: (snapshot: Snapshot) => void;
};

export function SnapshotDetailModals({
  snapshot,
  section,
  onSectionChange,
  canCreateSession,
  onCreateSession,
}: SnapshotDetailModalsProps) {
  const [content, setContent] = useState<Snapshot | null>(null);

  useEffect(() => {
    if (snapshot) {
      setContent(snapshot);
    }
  }, [snapshot]);

  function closeIfNeeded(open: boolean) {
    if (!open) {
      onSectionChange(null);
    }
  }

  const displayedSnapshot = snapshot ?? content;

  return (
    <Dialog open={section !== null && snapshot !== null} onOpenChange={closeIfNeeded}>
      <DialogContent className="flex h-[min(80vh,720px)] flex-col overflow-hidden sm:max-w-3xl">
        {displayedSnapshot ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {displayedSnapshot.name}
                <DeletedBadge deletedAt={displayedSnapshot.deletedAt} />
              </DialogTitle>
              <DialogDescription>Snapshot details</DialogDescription>
            </DialogHeader>
            <Tabs
              value={section ?? "details"}
              onValueChange={(value) => {
                if (isSnapshotDetailSection(value)) {
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
                <TabsTrigger value="events">
                  <Clock3 data-icon="inline-start" />
                  Events
                </TabsTrigger>
              </TabsList>
              <div className="min-h-0 flex-1">
                <TabsContent value="details" className="flex h-full min-h-0 flex-col gap-4">
                  <ScrollArea className="min-h-0 flex-1">
                    <MetadataGrid
                      items={[
                        { label: "ID", value: displayedSnapshot.id },
                        {
                          label: "Description",
                          value: displayedSnapshot.description ?? "—",
                        },
                        { label: "Tenant", value: displayedSnapshot.tenantId },
                        { label: "Parent", value: displayedSnapshot.parentSnapshotId ?? "—" },
                        {
                          label: "Promoted from",
                          value: displayedSnapshot.promotedFromSessionId ?? "—",
                        },
                        {
                          label: "Created",
                          value: metadataTimestamp(displayedSnapshot.createdAt),
                        },
                        {
                          label: "Expires",
                          value: metadataTimestamp(displayedSnapshot.expiresAt),
                        },
                        {
                          label: "Deleted",
                          value: metadataTimestamp(displayedSnapshot.deletedAt),
                        },
                        {
                          label: "Tags",
                          value: <TagBadges tags={displayedSnapshot.tags} max={10} />,
                        },
                      ]}
                    />
                  </ScrollArea>
                  {canCreateSession && !displayedSnapshot.deletedAt ? (
                    <DialogFooter>
                      <Button type="button" onClick={() => onCreateSession(displayedSnapshot)}>
                        <AppWindow data-icon="inline-start" />
                        Create session
                      </Button>
                    </DialogFooter>
                  ) : null}
                </TabsContent>
                <TabsContent value="events" className="h-full min-h-0">
                  <ScrollArea className="h-full">
                    <EventsPanel resourceType="snapshot" resourceId={displayedSnapshot.id} />
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

function isSnapshotDetailSection(value: string): value is SnapshotDetailSection {
  return value === "details" || value === "events";
}
