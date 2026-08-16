import { EventsPanel } from "#/components/resources/events-panel.tsx";
import { MetadataGrid, metadataTimestamp } from "#/components/resources/metadata-grid.tsx";
import { SessionStatusBadge } from "#/components/resources/status-badge.tsx";
import { TagBadges } from "#/components/resources/tag-badges.tsx";
import { ConnectionPanel } from "#/components/sessions/connection-panel.tsx";
import { ScrollArea } from "#/components/ui/scroll-area.tsx";
import { Separator } from "#/components/ui/separator.tsx";
import type { Session } from "#/lib/api/schemas.ts";

type SessionInspectorPaneProps = {
  session: Session | null;
};

export function SessionInspectorPane({ session }: SessionInspectorPaneProps) {
  if (!session) {
    return (
      <div className="flex h-full items-center justify-center border-l p-4 text-sm text-muted-foreground">
        Select a session
      </div>
    );
  }

  return (
    <ScrollArea className="h-full border-l">
      <div className="space-y-4 p-3">
        <div className="flex items-center gap-2">
          <div className="min-w-0">
            {session.label ? (
              <h2 className="truncate text-sm font-medium">{session.label}</h2>
            ) : null}
            <div
              className={
                session.label
                  ? "break-all font-mono text-xs text-muted-foreground"
                  : "break-all font-mono text-sm"
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
