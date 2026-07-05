import { useState } from "react";
import { EventsPanel } from "#/components/resources/events-panel.tsx";
import { MetadataGrid, metadataTimestamp } from "#/components/resources/metadata-grid.tsx";
import { SessionStatusBadge } from "#/components/resources/status-badge.tsx";
import { TagBadges } from "#/components/resources/tag-badges.tsx";
import {
  ConnectionPanel,
  type TransientCdpCredentials,
} from "#/components/sessions/connection-panel.tsx";
import { ScrollArea } from "#/components/ui/scroll-area.tsx";
import { Separator } from "#/components/ui/separator.tsx";
import type { Session } from "#/lib/api/schemas.ts";

type SessionInspectorPaneProps = {
  session: Session | null;
};

export function SessionInspectorPane({ session }: SessionInspectorPaneProps) {
  const [transientCdp, setTransientCdp] = useState<TransientCdpCredentials>(null);

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
          <h2 className="min-w-0 break-all font-mono text-sm">{session.id}</h2>
          <SessionStatusBadge status={session.status} />
        </div>
        <MetadataGrid
          items={[
            { label: "ID", value: session.id },
            { label: "Tenant", value: session.tenantId },
            { label: "Channel", value: session.browserChannel ?? "—" },
            { label: "Snapshot", value: session.baseSnapshotName ?? "—" },
            { label: "Created", value: metadataTimestamp(session.createdAt) },
            { label: "Started", value: metadataTimestamp(session.startedAt) },
            { label: "Expires", value: metadataTimestamp(session.expiresAt) },
            { label: "Tags", value: <TagBadges tags={session.tags} max={8} /> },
          ]}
        />
        <Separator />
        <ConnectionPanel
          session={session}
          transientCdp={transientCdp}
          onRotate={(credentials) => setTransientCdp(credentials)}
        />
        <Separator />
        <EventsPanel resourceType="session" resourceId={session.id} />
      </div>
    </ScrollArea>
  );
}
