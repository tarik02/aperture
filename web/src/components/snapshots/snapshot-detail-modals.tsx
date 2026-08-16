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

type RetainedSnapshotDetailContent = {
  snapshot: Snapshot;
  section: SnapshotDetailSection;
};

export function SnapshotDetailModals({
  snapshot,
  section,
  onSectionChange,
  canCreateSession,
  onCreateSession,
}: SnapshotDetailModalsProps) {
  const [content, setContent] = useState<RetainedSnapshotDetailContent | null>(null);

  useEffect(() => {
    if (snapshot && section) {
      setContent({ snapshot, section });
    }
  }, [section, snapshot]);

  function closeIfNeeded(open: boolean) {
    if (!open) {
      onSectionChange(null);
    }
  }

  const displayedSnapshot = snapshot ?? content?.snapshot;
  const displayedSection = section ?? content?.section ?? "details";

  return (
    <Dialog open={section !== null && snapshot !== null} onOpenChange={closeIfNeeded}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-3xl">
        {displayedSnapshot ? (
          <>
            <DialogHeader className="gap-0 px-4 pt-4 pr-12 pb-3">
              <DialogTitle className="flex items-center gap-2">
                {displayedSnapshot.name}
                <DeletedBadge deletedAt={displayedSnapshot.deletedAt} />
              </DialogTitle>
            </DialogHeader>
            <Tabs
              value={displayedSection}
              onValueChange={(value) => {
                if (isSnapshotDetailSection(value)) {
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
                <TabsTrigger value="events" className="h-full flex-none rounded-none px-2.5">
                  <Clock3 data-icon="inline-start" />
                  Events
                </TabsTrigger>
              </TabsList>
              <div className="h-[min(50svh,20rem)] min-h-0 overflow-hidden p-4">
                <TabsContent value="details" className="flex h-full min-h-0 flex-col gap-4">
                  <ScrollArea className="min-h-0 flex-1" viewportClassName="pr-3">
                    <MetadataGrid
                      items={[
                        { kind: "identifier", label: "ID", value: displayedSnapshot.id },
                        {
                          kind: "text",
                          label: "Description",
                          value: displayedSnapshot.description ?? "—",
                        },
                        {
                          kind: "identifier",
                          label: "Tenant",
                          value: displayedSnapshot.tenantId,
                        },
                        {
                          kind: "identifier",
                          label: "Parent",
                          value: displayedSnapshot.parentSnapshotId,
                        },
                        {
                          kind: "identifier",
                          label: "Promoted from",
                          value: displayedSnapshot.promotedFromSessionId,
                        },
                        {
                          kind: "text",
                          label: "Created",
                          value: metadataTimestamp(displayedSnapshot.createdAt),
                        },
                        {
                          kind: "text",
                          label: "Expires",
                          value: metadataTimestamp(displayedSnapshot.expiresAt),
                        },
                        {
                          kind: "text",
                          label: "Deleted",
                          value: metadataTimestamp(displayedSnapshot.deletedAt),
                        },
                        {
                          kind: "text",
                          label: "Tags",
                          value: <TagBadges tags={displayedSnapshot.tags} max={10} />,
                        },
                      ]}
                    />
                  </ScrollArea>
                  {canCreateSession && !displayedSnapshot.deletedAt ? (
                    <DialogFooter className="shrink-0">
                      <Button type="button" onClick={() => onCreateSession(displayedSnapshot)}>
                        <AppWindow data-icon="inline-start" />
                        Create session
                      </Button>
                    </DialogFooter>
                  ) : null}
                </TabsContent>
                <TabsContent value="events" className="h-full min-h-0">
                  <EventsPanel
                    resourceType="snapshot"
                    resourceId={displayedSnapshot.id}
                    className="h-full"
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

function isSnapshotDetailSection(value: string): value is SnapshotDetailSection {
  return value === "details" || value === "events";
}
