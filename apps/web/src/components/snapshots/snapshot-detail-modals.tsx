import { AppWindow, Clock3, Info } from "lucide-react";
import { useEffect, useState } from "react";
import { EventsPanel } from "#/components/resources/events-panel.tsx";
import { MetadataGrid, metadataTimestamp } from "#/components/resources/metadata-grid.tsx";
import { DeletedBadge } from "#/components/resources/status-badge.tsx";
import { TagBadges } from "#/components/resources/tag-badges.tsx";
import { Button } from "@aperture-browser/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import { ScrollArea } from "@aperture-browser/ui/components/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@aperture-browser/ui/components/tabs";
import type { Snapshot } from "@aperture-browser/api-client";

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
      <DialogContent className="aperture:gap-0 aperture:overflow-hidden aperture:p-0 aperture:sm:max-w-3xl">
        {displayedSnapshot ? (
          <>
            <DialogHeader className="aperture:gap-0 aperture:px-4 aperture:pt-4 aperture:pr-12 aperture:pb-3">
              <DialogTitle className="aperture:flex aperture:items-center aperture:gap-2">
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
              className="aperture:min-h-0 aperture:gap-0"
            >
              <TabsList
                variant="line"
                className="aperture:h-10 aperture:w-full aperture:shrink-0 aperture:justify-start aperture:border-y aperture:px-4 aperture:py-0"
              >
                <TabsTrigger
                  value="details"
                  className="aperture:h-full aperture:flex-none aperture:rounded-none aperture:px-2.5"
                >
                  <Info data-icon="inline-start" />
                  Details
                </TabsTrigger>
                <TabsTrigger
                  value="events"
                  className="aperture:h-full aperture:flex-none aperture:rounded-none aperture:px-2.5"
                >
                  <Clock3 data-icon="inline-start" />
                  Events
                </TabsTrigger>
              </TabsList>
              <div className="aperture:h-[min(50svh,20rem)] aperture:min-h-0 aperture:overflow-hidden aperture:p-4">
                <TabsContent
                  value="details"
                  className="aperture:flex aperture:h-full aperture:min-h-0 aperture:flex-col aperture:gap-4"
                >
                  <ScrollArea
                    className="aperture:min-h-0 aperture:flex-1"
                    viewportClassName="aperture:pr-3"
                  >
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
                    <DialogFooter className="aperture:shrink-0">
                      <Button type="button" onClick={() => onCreateSession(displayedSnapshot)}>
                        <AppWindow data-icon="inline-start" />
                        Create session
                      </Button>
                    </DialogFooter>
                  ) : null}
                </TabsContent>
                <TabsContent value="events" className="aperture:h-full aperture:min-h-0">
                  <EventsPanel
                    resourceType="snapshot"
                    resourceId={displayedSnapshot.id}
                    className="aperture:h-full"
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
