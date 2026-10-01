import { EventsPanel } from "#/components/resources/events-panel.tsx";
import { MetadataGrid, metadataTimestamp } from "#/components/resources/metadata-grid.tsx";
import { SessionStatusBadge } from "#/components/resources/status-badge.tsx";
import { TagBadges } from "#/components/resources/tag-badges.tsx";
import { ConnectionPanel } from "#/components/sessions/connection-panel.tsx";
import { ScrollArea } from "@aperture-browser/ui/components/scroll-area";
import { Separator } from "@aperture-browser/ui/components/separator";
import type { Session } from "@aperture-browser/api-client";

type SessionInspectorPaneProps = {
  session: Session | null;
};

export function SessionInspectorPane({ session }: SessionInspectorPaneProps) {
  if (!session) {
    return (
      <div className="aperture:flex aperture:h-full aperture:items-center aperture:justify-center aperture:border-l aperture:p-4 aperture:text-sm aperture:text-muted-foreground">
        Select a session
      </div>
    );
  }

  return (
    <ScrollArea className="aperture:h-full aperture:border-l">
      <div className="aperture:space-y-4 aperture:p-3">
        <div className="aperture:flex aperture:items-center aperture:gap-2">
          <div className="aperture:min-w-0">
            {session.label ? (
              <h2 className="aperture:truncate aperture:text-sm aperture:font-medium">
                {session.label}
              </h2>
            ) : null}
            <div
              className={
                session.label
                  ? "aperture:break-all aperture:font-mono aperture:text-xs aperture:text-muted-foreground"
                  : "aperture:break-all aperture:font-mono aperture:text-sm"
              }
            >
              {session.id}
            </div>
          </div>
          <SessionStatusBadge status={session.status} />
        </div>
        <MetadataGrid
          items={[
            { kind: "text", label: "Label", value: session.label ?? "—" },
            { kind: "identifier", label: "ID", value: session.id },
            { kind: "identifier", label: "Tenant", value: session.tenantId },
            { kind: "text", label: "Channel", value: session.browserChannel ?? "—" },
            { kind: "text", label: "Snapshot", value: session.baseSnapshotName ?? "—" },
            { kind: "text", label: "Created", value: metadataTimestamp(session.createdAt) },
            { kind: "text", label: "Started", value: metadataTimestamp(session.startedAt) },
            { kind: "text", label: "Expires", value: metadataTimestamp(session.expiresAt) },
            {
              kind: "text",
              label: "Tags",
              value: <TagBadges tags={session.tags} max={8} />,
            },
          ]}
        />
        <Separator />
        <ConnectionPanel session={session} />
        <Separator />
        <EventsPanel resourceType="session" resourceId={session.id} />
      </div>
    </ScrollArea>
  );
}
