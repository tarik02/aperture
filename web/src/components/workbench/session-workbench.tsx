import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { TenantRequiredNotice } from "#/components/resources/tenant-required.tsx";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty.tsx";
import { Button } from "#/components/ui/button.tsx";
import { BrowserControlPane } from "#/components/workbench/browser-control-pane.tsx";
import {
  SessionDetailModals,
  type SessionDetailSection,
} from "#/components/sessions/session-detail-modals.tsx";
import { useBrowserControl } from "#/hooks/use-browser-control.ts";
import { useRecentSessionsStore } from "#/features/session/recent-sessions.store.ts";
import { useWorkbenchSession } from "#/hooks/use-workbench-session.ts";
import { hasScope, useActiveScopes } from "#/hooks/use-scopes.ts";
import { isTenantScopedQueryReady, useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { AppWindow, Loader2 } from "lucide-react";
import type { ApiCredentials } from "#/lib/api/client.ts";
import type { Session } from "#/lib/api/schemas.ts";
import type { CollaborationRole } from "#/lib/control/live-session-protocol.ts";

type SessionWorkbenchProps = {
  sessionId: string;
  capability?: {
    credentials: ApiCredentials;
    role: Exclude<CollaborationRole, "owner">;
    session: Pick<Session, "id" | "status" | "capabilities" | "connection">;
  };
};

const emptyIceServers: RTCIceServer[] = [];

export function SessionWorkbench({ sessionId, capability }: SessionWorkbenchProps) {
  const profileCredentials = useApiCredentials();
  const credentials = capability?.credentials ?? profileCredentials;
  const scopes = useActiveScopes();
  const guestMode = capability !== undefined;
  const collaborationRole = capability?.role ?? "owner";
  const canControl = guestMode || hasScope(scopes, "sessions:write");
  const tenantReady = guestMode || isTenantScopedQueryReady(credentials);
  const recordRecentSession = useRecentSessionsStore((state) => state.recordSession);
  const lastRecordedSessionId = useRef<string | null>(null);
  const [publicOrigin, setPublicOrigin] = useState<string | null>(null);
  const [detailSection, setDetailSection] = useState<SessionDetailSection | null>(null);

  const { session: ownerSession, isResolvingRoute } = useWorkbenchSession(
    guestMode ? undefined : sessionId,
  );
  const selectedSession = capability?.session ?? ownerSession;
  const canConnectSession = Boolean(
    selectedSession?.status === "running" || selectedSession?.status === "suspended",
  );
  const cdpUrl = useMemo(() => {
    if (guestMode) {
      return null;
    }
    const connection = selectedSession?.connection;
    if (!connection?.cdpUrl || !connection.sessionToken || !publicOrigin) {
      return null;
    }
    const sourceUrl = new URL(connection.cdpUrl, publicOrigin);
    const url = new URL(publicOrigin);
    url.pathname = `${sourceUrl.pathname.replace(/\/$/, "")}/${encodeURIComponent(connection.sessionToken)}`;
    return url.toString();
  }, [guestMode, publicOrigin, selectedSession?.connection]);
  const shareUrls = useMemo(() => {
    if (!publicOrigin || !ownerSession?.collaboration) {
      return null;
    }
    return {
      editor: shareURL(publicOrigin, ownerSession.collaboration.editorToken),
      viewer: shareURL(publicOrigin, ownerSession.collaboration.viewerToken),
    };
  }, [ownerSession?.collaboration, publicOrigin]);

  const control = useBrowserControl({
    sessionId: canConnectSession && selectedSession ? selectedSession.id : null,
    credentials: capability?.credentials,
    sessionToken: selectedSession?.connection.sessionToken,
    collaborationRole,
    enabled: canControl && tenantReady && canConnectSession,
    webrtcProducerSupported:
      selectedSession?.capabilities.liveView.transports.includes("webrtc") ?? false,
    webrtcIceServers: selectedSession?.connection.webrtc?.iceServers ?? emptyIceServers,
    recordingSupported: selectedSession?.capabilities.recording !== undefined,
    remoteCursorSupported: selectedSession?.capabilities.remoteCursor ?? false,
  });

  useEffect(() => {
    setPublicOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    if (guestMode || !selectedSession || lastRecordedSessionId.current === selectedSession.id) {
      return;
    }

    lastRecordedSessionId.current = selectedSession.id;
    recordRecentSession(selectedSession.id);
  }, [guestMode, recordRecentSession, selectedSession]);

  if (!tenantReady) {
    return (
      <div className="flex h-full min-h-0 flex-col p-3">
        <TenantRequiredNotice />
      </div>
    );
  }

  if (!canControl) {
    return (
      <Empty className="h-full border-none">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <AppWindow />
          </EmptyMedia>
          <EmptyTitle>sessions:write required</EmptyTitle>
          <EmptyDescription>
            Switch to a token with session write scope to control browsers.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {isResolvingRoute ? (
        <Empty className="h-full border-none">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Loader2 className="animate-spin" />
            </EmptyMedia>
            <EmptyTitle>Loading session</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : selectedSession ? (
        <BrowserControlPane
          key={selectedSession.id}
          control={control}
          guestMode={guestMode}
          collaborationRole={collaborationRole}
          cdpUrl={cdpUrl}
          shareUrls={shareUrls}
          onSessionDetails={guestMode ? undefined : () => setDetailSection("details")}
        />
      ) : (
        <Empty className="h-full border-none">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <AppWindow />
            </EmptyMedia>
            <EmptyTitle>Session unavailable</EmptyTitle>
            <EmptyDescription>
              Open a running or suspended session from the sessions table.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" size="sm" render={<Link to="/-/sessions" />}>
              Sessions
            </Button>
          </EmptyContent>
        </Empty>
      )}
      {!guestMode ? (
        <SessionDetailModals
          session={ownerSession}
          section={detailSection}
          onSectionChange={setDetailSection}
        />
      ) : null}
    </div>
  );
}

function shareURL(origin: string, token: string) {
  const url = new URL("/share/", origin);
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}
