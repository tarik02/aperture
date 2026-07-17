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
import { useBrowserControl } from "#/hooks/use-browser-control.ts";
import { useRecentSessionsStore } from "#/features/session/recent-sessions.store.ts";
import { useWorkbenchSession } from "#/hooks/use-workbench-session.ts";
import { hasScope, useActiveScopes } from "#/hooks/use-scopes.ts";
import { isTenantScopedQueryReady, useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { AppWindow, Loader2 } from "lucide-react";
import type { ApiCredentials } from "#/lib/api/client.ts";
import type { Session } from "#/lib/api/schemas.ts";

type SessionWorkbenchProps = {
  sessionId: string;
  forceCDPMedia?: boolean;
  capability?: {
    credentials: ApiCredentials;
    session: Pick<Session, "id" | "status" | "media" | "cdpUrl" | "cdpToken">;
  };
};

const emptyIceServers: RTCIceServer[] = [];

export function SessionWorkbench({
  sessionId,
  forceCDPMedia = false,
  capability,
}: SessionWorkbenchProps) {
  const profileCredentials = useApiCredentials();
  const credentials = capability?.credentials ?? profileCredentials;
  const scopes = useActiveScopes();
  const guestMode = capability !== undefined;
  const canControl = guestMode || hasScope(scopes, "sessions:write");
  const tenantReady = guestMode || isTenantScopedQueryReady(credentials);
  const recordRecentSession = useRecentSessionsStore((state) => state.recordSession);
  const lastRecordedSessionId = useRef<string | null>(null);
  const [publicOrigin, setPublicOrigin] = useState<string | null>(null);

  const { session: ownerSession, isResolvingRoute } = useWorkbenchSession(
    guestMode ? undefined : sessionId,
  );
  const selectedSession = capability?.session ?? ownerSession;
  const canConnectSession = Boolean(
    selectedSession?.status === "running" || selectedSession?.status === "suspended",
  );
  const cdpUrl = useMemo(() => {
    if (!selectedSession?.cdpUrl || !selectedSession.cdpToken || !publicOrigin) {
      return null;
    }
    const sourceUrl = new URL(selectedSession.cdpUrl, publicOrigin);
    const url = new URL(publicOrigin);
    url.pathname = `${sourceUrl.pathname.replace(/\/$/, "")}/${encodeURIComponent(selectedSession.cdpToken)}`;
    return url.toString();
  }, [publicOrigin, selectedSession?.cdpToken, selectedSession?.cdpUrl]);
  const shareUrl = useMemo(() => {
    if (!publicOrigin || !selectedSession?.cdpToken) {
      return null;
    }
    const url = new URL("/share/", publicOrigin);
    url.hash = new URLSearchParams({ token: selectedSession.cdpToken }).toString();
    return url.toString();
  }, [publicOrigin, selectedSession?.cdpToken]);

  const control = useBrowserControl({
    sessionId: canConnectSession && selectedSession ? selectedSession.id : null,
    credentials: capability?.credentials,
    cdpToken: capability?.session.cdpToken,
    enabled: canControl && tenantReady && canConnectSession,
    forceCDPMedia,
    webrtcProducerSupported:
      selectedSession?.media.mode === "auto" && selectedSession.media.webrtcProducer,
    webrtcIceServers: selectedSession?.media.iceServers ?? emptyIceServers,
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
          control={control}
          guestMode={guestMode}
          cdpUrl={cdpUrl}
          shareUrl={shareUrl}
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
    </div>
  );
}
