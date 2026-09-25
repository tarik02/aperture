import { Link } from "@tanstack/react-router";
import { PanelLeftIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { TenantRequiredNotice } from "#/components/resources/tenant-required.tsx";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@aperture-browser/ui/components/empty";
import { Button } from "@aperture-browser/ui/components/button";
import { Spinner } from "@aperture-browser/ui/components/spinner";
import {
  BrowserControlPane,
  devToolsUrl,
  useBrowserControl,
} from "@aperture-browser/session-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@aperture-browser/ui/components/tooltip";
import {
  SessionDetailModals,
  type SessionDetailSection,
} from "#/components/sessions/session-detail-modals.tsx";
import { useRecentSessionsStore } from "#/features/session/recent-sessions.store.ts";
import { useWorkbenchSession } from "#/hooks/use-workbench-session.ts";
import { hasScope, useActiveScopes } from "#/hooks/use-scopes.ts";
import { isTenantScopedQueryReady, useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { AppWindow } from "lucide-react";
import type { IceServer } from "@aperture-browser/api-client";
import { selectPrincipal, useAuthSessionStore } from "#/stores/auth-session.ts";

interface SessionWorkbenchProps {
  sessionId: string;
}

const emptyIceServers: readonly IceServer[] = [];

/** The owner's view of one of their sessions. Shared links use SharedSession instead. */
export function SessionWorkbench({ sessionId }: SessionWorkbenchProps) {
  const credentials = useApiCredentials();
  const principal = useAuthSessionStore(selectPrincipal);
  const scopes = useActiveScopes();
  const canControl = hasScope(scopes, "sessions:write");
  const tenantReady = isTenantScopedQueryReady(credentials);
  const recordRecentSession = useRecentSessionsStore((state) => state.recordSession);
  const lastRecordedSessionId = useRef<string | null>(null);
  const [publicOrigin, setPublicOrigin] = useState<string | null>(null);
  const [detailSection, setDetailSection] = useState<SessionDetailSection | null>(null);

  const { session: selectedSession, isResolvingRoute } = useWorkbenchSession(sessionId);
  const canConnectSession = Boolean(
    selectedSession?.status === "running" || selectedSession?.status === "suspended",
  );
  const cdpUrl = useMemo(
    () =>
      selectedSession?.cdpUrl && selectedSession.sessionToken && publicOrigin
        ? devToolsUrl(publicOrigin, selectedSession.cdpUrl, selectedSession.sessionToken)
        : null,
    [publicOrigin, selectedSession?.sessionToken, selectedSession?.cdpUrl],
  );
  const shareUrls = useMemo(() => {
    if (!publicOrigin || !selectedSession?.collaboration) {
      return null;
    }
    return {
      editor: shareURL(publicOrigin, selectedSession.collaboration.editorToken),
      viewer: shareURL(publicOrigin, selectedSession.collaboration.viewerToken),
    };
  }, [selectedSession?.collaboration, publicOrigin]);

  const control = useBrowserControl({
    sessionId: canConnectSession && selectedSession ? selectedSession.id : null,
    credentials,
    displayName: principal?.name ?? null,
    sessionToken: selectedSession?.sessionToken,
    collaborationRole: "owner",
    enabled: canControl && tenantReady && canConnectSession,
    webrtcProducerSupported:
      selectedSession?.media.mode === "auto" && selectedSession.media.webrtcProducer,
    webrtcIceServers: selectedSession?.media.iceServers ?? emptyIceServers,
  });

  useEffect(() => {
    setPublicOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    if (!selectedSession || lastRecordedSessionId.current === selectedSession.id) {
      return;
    }

    lastRecordedSessionId.current = selectedSession.id;
    recordRecentSession(selectedSession.id);
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
              <Spinner />
            </EmptyMedia>
            <EmptyTitle>Loading session</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : selectedSession?.status === "creating" ? (
        <Empty className="h-full border-none">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Spinner />
            </EmptyMedia>
            <EmptyTitle>Starting session</EmptyTitle>
            <EmptyDescription>Restoring browser state…</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : selectedSession?.status === "failed" ? (
        <Empty className="h-full border-none">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <AppWindow />
            </EmptyMedia>
            <EmptyTitle>Session failed to start</EmptyTitle>
            <EmptyDescription>Open the session details to inspect the failure.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" size="sm" render={<Link to="/-/sessions" />}>
              Sessions
            </Button>
          </EmptyContent>
        </Empty>
      ) : selectedSession ? (
        <BrowserControlPane
          key={selectedSession.id}
          control={control}
          leading={<BackToSessions />}
          collaborationRole="owner"
          cdpUrl={cdpUrl}
          shareUrls={shareUrls}
          onSessionDetails={() => setDetailSection("details")}
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
      <SessionDetailModals
        session={selectedSession}
        section={detailSection}
        onSectionChange={setDetailSection}
      />
    </div>
  );
}

function BackToSessions() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="h-full aspect-square shrink-0 rounded-none"
            aria-label="Back to sessions"
            render={<Link to="/-/sessions" />}
          />
        }
      >
        <PanelLeftIcon />
      </TooltipTrigger>
      <TooltipContent side="bottom">Sessions</TooltipContent>
    </Tooltip>
  );
}

function shareURL(origin: string, token: string) {
  const url = new URL("/share/", origin);
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}
