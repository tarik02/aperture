import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
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

type SessionWorkbenchProps = {
  sessionId: string;
  forceCDPMedia?: boolean;
};

const emptyIceServers: RTCIceServer[] = [];

export function SessionWorkbench({ sessionId, forceCDPMedia = false }: SessionWorkbenchProps) {
  const credentials = useApiCredentials();
  const scopes = useActiveScopes();
  const canControl = hasScope(scopes, "sessions:write");
  const tenantReady = isTenantScopedQueryReady(credentials);
  const recordRecentSession = useRecentSessionsStore((state) => state.recordSession);
  const lastRecordedSessionId = useRef<string | null>(null);

  const { session: selectedSession, isResolvingRoute } = useWorkbenchSession(sessionId);

  const control = useBrowserControl({
    sessionId: selectedSession?.status === "running" ? selectedSession.id : null,
    enabled: canControl && tenantReady && selectedSession?.status === "running",
    forceCDPMedia,
    webrtcProducerSupported:
      selectedSession?.media.mode === "auto" && selectedSession.media.webrtcProducer,
    webrtcIceServers: selectedSession?.media.iceServers ?? emptyIceServers,
  });

  useEffect(() => {
    if (!selectedSession || lastRecordedSessionId.current === selectedSession.id) {
      return;
    }

    lastRecordedSessionId.current = selectedSession.id;
    recordRecentSession(selectedSession);
  }, [recordRecentSession, selectedSession]);

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
        <BrowserControlPane control={control} />
      ) : (
        <Empty className="h-full border-none">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <AppWindow />
            </EmptyMedia>
            <EmptyTitle>Session unavailable</EmptyTitle>
            <EmptyDescription>Open a running session from the sessions table.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" size="sm" render={<Link to="/sessions" />}>
              Sessions
            </Button>
          </EmptyContent>
        </Empty>
      )}
    </div>
  );
}
