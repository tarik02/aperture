import type { SessionAccess } from "@aperture-browser/live-session";
import { Link } from "@tanstack/react-router";
import * as Redacted from "effect/Redacted";
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
  showNotice,
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
import { ApiRequestError, type IceServer } from "@aperture-browser/api-client";
import { selectAuth, useAuthSessionStore } from "#/stores/auth-session.ts";
import { useTenantSelection } from "#/hooks/use-tenant-selection.ts";

interface SessionWorkbenchProps {
  sessionId: string;
}

const emptyIceServers: readonly IceServer[] = [];

export function SessionWorkbench({ sessionId }: SessionWorkbenchProps) {
  const credentials = useApiCredentials();
  const auth = useAuthSessionStore(selectAuth);
  const principal = auth?.principal;
  const { selectTenant, switching } = useTenantSelection();
  const scopes = useActiveScopes();
  const canControl = hasScope(scopes, "sessions:write");
  const tenantReady = isTenantScopedQueryReady(credentials);
  const recordRecentSession = useRecentSessionsStore((state) => state.recordSession);
  const lastRecordedSessionId = useRef<string | null>(null);
  const [publicOrigin, setPublicOrigin] = useState<string | null>(null);
  const [detailSection, setDetailSection] = useState<SessionDetailSection | null>(null);

  const {
    session: selectedSession,
    owningTenant,
    isResolvingRoute,
    error: lookupError,
    retry,
  } = useWorkbenchSession(sessionId);
  const canConnectSession = Boolean(
    selectedSession?.status === "running" || selectedSession?.status === "suspended",
  );
  const cdpUrl = useMemo(
    () =>
      selectedSession?.cdpUrl && selectedSession.sessionToken && publicOrigin
        ? devToolsUrl(
            publicOrigin,
            selectedSession.cdpUrl,
            Redacted.value(selectedSession.sessionToken),
          )
        : null,
    [publicOrigin, selectedSession?.sessionToken, selectedSession?.cdpUrl],
  );
  const shareUrls = useMemo(() => {
    if (!publicOrigin || !selectedSession?.collaboration) {
      return null;
    }
    return {
      editor: shareURL(publicOrigin, Redacted.value(selectedSession.collaboration.editorToken)),
      viewer: shareURL(publicOrigin, Redacted.value(selectedSession.collaboration.viewerToken)),
    };
  }, [selectedSession?.collaboration, publicOrigin]);

  const access = useMemo<SessionAccess | null>(
    () =>
      canConnectSession && selectedSession && credentials
        ? {
            kind: "direct",
            sessionId: selectedSession.id,
            credentials:
              selectedSession.sessionToken === undefined
                ? credentials
                : {
                    ...credentials,
                    kind: "bearer",
                    token: selectedSession.sessionToken,
                  },
          }
        : null,
    [canConnectSession, selectedSession?.id, selectedSession?.sessionToken, credentials],
  );
  const control = useBrowserControl({
    access,
    displayName: principal?.name ?? null,
    enabled: canControl && tenantReady && canConnectSession,
    webrtcProducerSupported:
      selectedSession?.media.mode === "auto" && selectedSession.media.webrtcProducer,
    webrtcIceServers: selectedSession?.media.iceServers ?? emptyIceServers,
    onNotice: showNotice,
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

  if (isResolvingRoute) {
    return (
      <Empty className="aperture:h-full aperture:border-none">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Spinner />
          </EmptyMedia>
          <EmptyTitle>Loading session</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }

  if (
    selectedSession === null &&
    owningTenant !== null &&
    owningTenant.id !== auth?.selectedTenant?.id
  ) {
    return (
      <Empty className="aperture:h-full aperture:border-none">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <AppWindow />
          </EmptyMedia>
          <EmptyTitle>This session belongs to {owningTenant.displayName}</EmptyTitle>
          <EmptyDescription>
            {auth?.selectedTenant === null
              ? "You haven't selected a tenant."
              : `You're currently in ${auth?.selectedTenant?.displayName}.`}{" "}
            Open it with a temporary tenant selection for this tab. Your remembered tenant and other
            tabs stay unchanged.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button disabled={switching} onClick={() => void selectTenant(owningTenant.id, true)}>
            {switching ? <Spinner data-icon="inline-start" /> : null}
            Open in {owningTenant.displayName} for this tab
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  if (selectedSession === null && lookupError !== null) {
    const inaccessible =
      lookupError instanceof ApiRequestError &&
      (lookupError.status === 404 || lookupError.status === 403);
    return (
      <Empty className="aperture:h-full aperture:border-none">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <AppWindow />
          </EmptyMedia>
          <EmptyTitle>
            {inaccessible ? "Session not found or access denied" : "Couldn't load session"}
          </EmptyTitle>
          <EmptyDescription>
            {inaccessible
              ? "This session may have been deleted, or your account doesn't have permission to open it."
              : lookupError.message}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" size="sm" onClick={() => void retry()}>
            Try again
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  if (!tenantReady) {
    return (
      <div className="aperture:flex aperture:h-full aperture:min-h-0 aperture:flex-col aperture:p-3">
        <TenantRequiredNotice />
      </div>
    );
  }

  if (!canControl) {
    return (
      <Empty className="aperture:h-full aperture:border-none">
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
    <div className="aperture:flex aperture:h-full aperture:min-h-0 aperture:flex-1 aperture:flex-col aperture:overflow-hidden aperture:bg-background">
      {selectedSession?.status === "creating" ? (
        <Empty className="aperture:h-full aperture:border-none">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Spinner />
            </EmptyMedia>
            <EmptyTitle>Starting session</EmptyTitle>
            <EmptyDescription>Restoring browser state…</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : selectedSession?.status === "failed" ? (
        <Empty className="aperture:h-full aperture:border-none">
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
        <Empty className="aperture:h-full aperture:border-none">
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
            className="aperture:h-full aperture:aspect-square aperture:shrink-0 aperture:rounded-none"
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
