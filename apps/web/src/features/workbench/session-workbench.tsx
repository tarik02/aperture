import type { SessionAccess } from "@aperture-browser/live-session";
import { useIsMutating } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import * as Redacted from "effect/Redacted";
import {
  AppWindow,
  Camera,
  LayoutGrid,
  MoreHorizontal,
  Network,
  PanelLeft,
  RotateCcw,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiRequestError, type IceServer, type Session } from "@aperture-browser/api-client";
import { Button } from "@aperture-browser/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@aperture-browser/ui/components/empty";
import { Spinner } from "@aperture-browser/ui/components/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@aperture-browser/ui/components/tooltip";
import { cn } from "@aperture-browser/ui/utils";
import {
  BrowserControlPane,
  devToolsUrl,
  showNotice,
  useBrowserControl,
} from "@aperture-browser/session-react";
import { TenantRequiredNotice } from "#/components/resources/tenant-required.tsx";
import { isTenantScopedQueryReady, useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { useTenantSelection } from "#/hooks/use-tenant-selection.ts";
import { useWorkbenchSession } from "#/hooks/use-workbench-session.ts";
import { describeProxy, isProxyConfigured } from "#/features/proxy/proxy-config.ts";
import { useAnnounceOpenSession } from "#/features/session/open-sessions.ts";
import { useRecentSessionsStore } from "#/features/session/recent-sessions.store.ts";
import { SessionActionsMenu } from "#/features/session/session-actions-menu.tsx";
import { useSessionDialogs } from "#/features/session/session-dialogs.tsx";
import {
  saveToSnapshotMutationKey,
  type SaveToSnapshotInput,
} from "#/features/session/session.mutations.ts";
import { isReopenable, isSaveable, sessionLabel } from "#/features/session/session-display.ts";
import {
  SessionSwitcher,
  loadSwitcherPinned,
  saveSwitcherPinned,
} from "#/features/workbench/session-switcher.tsx";
import { selectAuth, useAuthSessionStore } from "#/stores/auth-session.ts";

type SessionWorkbenchProps = {
  sessionId: string;
  /** Stream frames over the session socket instead of WebRTC. */
  media?: "cdp";
  /** Open a new browser tab once connected. */
  openNewTab?: boolean;
  /**
   * Show ways to reach other sessions: the edge session list and the "All sessions" button.
   * An embedded workbench turns them off and keeps the session's own actions.
   */
  navigation?: boolean;
};

const emptyIceServers: readonly IceServer[] = [];
/** How long a hidden tab keeps its live connection before letting it go. */
const hiddenDisconnectMs = 30_000;

export function SessionWorkbench({
  sessionId,
  media,
  openNewTab = false,
  navigation = true,
}: SessionWorkbenchProps) {
  const navigate = useNavigate();
  const credentials = useApiCredentials();
  const auth = useAuthSessionStore(selectAuth);
  const { selectTenant, switching } = useTenantSelection();
  const tenantReady = isTenantScopedQueryReady(credentials);
  const recordRecentSession = useRecentSessionsStore((state) => state.recordSession);
  const [switcherPinned, setSwitcherPinned] = useState(false);
  const { actions, dialogs, permissions } = useSessionDialogs({
    currentSessionId: sessionId,
    onSessionDeleted: () => {
      if (navigation) {
        void navigate({ to: "/-/sessions" });
      }
    },
  });

  const {
    session,
    owningTenant,
    isResolvingRoute,
    error: lookupError,
    retry,
  } = useWorkbenchSession(sessionId);
  const connectable = session?.status === "running" || session?.status === "suspended";
  const hiddenLong = useHiddenFor(hiddenDisconnectMs);
  // A connected client would wake the session between the suspend and the save.
  const saving =
    useIsMutating({
      mutationKey: saveToSnapshotMutationKey,
      predicate: (mutation) =>
        (mutation.state.variables as SaveToSnapshotInput | undefined)?.session.id === sessionId,
    }) > 0;

  useEffect(() => {
    setSwitcherPinned(loadSwitcherPinned());
  }, []);

  useEffect(() => {
    if (session) {
      recordRecentSession(session.id);
    }
  }, [recordRecentSession, session?.id]);

  const publicOrigin = typeof window === "undefined" ? null : window.location.origin;
  const cdpUrl = useMemo(
    () =>
      session?.cdpUrl && session.sessionToken && publicOrigin
        ? devToolsUrl(publicOrigin, session.cdpUrl, Redacted.value(session.sessionToken))
        : null,
    [publicOrigin, session?.sessionToken, session?.cdpUrl],
  );
  const shareUrls = useMemo(() => {
    if (!publicOrigin || !session?.collaboration) {
      return null;
    }
    return {
      editor: shareUrl(publicOrigin, Redacted.value(session.collaboration.editorToken)),
      viewer: shareUrl(publicOrigin, Redacted.value(session.collaboration.viewerToken)),
    };
  }, [session?.collaboration, publicOrigin]);

  const access = useMemo<SessionAccess | null>(
    () =>
      connectable && session && credentials
        ? {
            kind: "direct",
            sessionId: session.id,
            credentials:
              session.sessionToken === undefined
                ? credentials
                : { ...credentials, kind: "bearer", token: session.sessionToken },
          }
        : null,
    [connectable, session?.id, session?.sessionToken, credentials],
  );
  const control = useBrowserControl({
    access,
    displayName: auth?.principal.name ?? null,
    // A tab hidden for a while lets the connection go; showing it again starts a fresh one.
    enabled: permissions.canWrite && tenantReady && connectable && !hiddenLong && !saving,
    webrtcProducerSupported:
      media !== "cdp" && session?.media.mode === "auto" && session.media.webrtcProducer,
    webrtcIceServers: session?.media.iceServers ?? emptyIceServers,
    onNotice: showNotice,
  });

  useAnnounceOpenSession(session?.id ?? null, control.activeTargetId, control.activateTarget);
  useDeepLinkTargets(
    control,
    openNewTab,
    () =>
      void navigate({
        to: "/-/sessions/$sessionId",
        params: { sessionId },
        search: (current) => ({ ...current, newTab: undefined }),
        hash: "",
        replace: true,
      }),
  );

  let content: ReactNode;
  if (isResolvingRoute) {
    content = <FullPageState icon={<Spinner />} title="Loading session" />;
  } else if (
    session === null &&
    owningTenant !== null &&
    owningTenant.id !== auth?.selectedTenant?.id
  ) {
    content = (
      <FullPageState
        icon={<AppWindow />}
        title={`This session belongs to ${owningTenant.displayName}`}
        description={`${
          auth?.selectedTenant === null
            ? "You haven't selected a tenant."
            : `You're currently in ${auth?.selectedTenant?.displayName}.`
        } Open it with a temporary tenant selection for this tab. Your remembered tenant and other tabs stay unchanged.`}
      >
        <Button disabled={switching} onClick={() => void selectTenant(owningTenant.id, true)}>
          {switching ? <Spinner data-icon="inline-start" /> : null}
          Open in {owningTenant.displayName} for this tab
        </Button>
      </FullPageState>
    );
  } else if (session === null && lookupError !== null) {
    const inaccessible =
      lookupError instanceof ApiRequestError &&
      (lookupError.status === 404 || lookupError.status === 403 || lookupError.status === 410);
    content = (
      <FullPageState
        icon={<AppWindow />}
        title={inaccessible ? "This browser session is unavailable." : "Couldn't load session"}
        description={
          inaccessible
            ? "It may have expired or been deleted, or your account can't open it."
            : lookupError.message
        }
      >
        <Button variant="outline" size="sm" onClick={() => void retry()}>
          Try again
        </Button>
        {navigation ? <AllSessionsButton /> : null}
      </FullPageState>
    );
  } else if (!tenantReady) {
    content = (
      <div className="aperture:flex aperture:h-full aperture:min-h-0 aperture:flex-col aperture:p-3">
        <TenantRequiredNotice />
      </div>
    );
  } else if (!permissions.canWrite) {
    content = (
      <FullPageState
        icon={<AppWindow />}
        title="Access to this browser session was denied."
        description="Switch to a token with the sessions:write scope to control browsers."
      />
    );
  } else if (!session) {
    content = (
      <FullPageState icon={<AppWindow />} title="This browser session is unavailable.">
        {navigation ? <AllSessionsButton /> : null}
      </FullPageState>
    );
  } else if (session.status === "creating") {
    content = (
      <FullPageState
        icon={<Spinner />}
        title="Starting session"
        description="Restoring browser state…"
      />
    );
  } else if (!connectable) {
    content = (
      <FullPageState
        icon={<AppWindow />}
        title={
          session.status === "failed"
            ? "This session failed to start."
            : `This session is ${session.status}.`
        }
        description={
          isReopenable(session.status)
            ? "Reopen it to start its browser again with the state it had."
            : undefined
        }
      >
        {isReopenable(session.status) ? (
          <Button size="sm" onClick={() => actions.reopen(session)}>
            <RotateCcw data-icon="inline-start" />
            Reopen session
          </Button>
        ) : null}
        <Button variant="outline" size="sm" onClick={() => actions.details(session, "events")}>
          Details
        </Button>
        {navigation ? <AllSessionsButton /> : null}
      </FullPageState>
    );
  } else {
    content = (
      <BrowserControlPane
        key={session.id}
        control={control}
        leading={
          navigation ? (
            <SwitcherToggle
              pinned={switcherPinned}
              onToggle={() => {
                saveSwitcherPinned(!switcherPinned);
                setSwitcherPinned(!switcherPinned);
              }}
            />
          ) : undefined
        }
        toolbarLeading={navigation ? <AllSessionsToolbarButton /> : undefined}
        toolbarTrailing={
          <WorkbenchActions session={session} actions={actions} permissions={permissions} />
        }
        collaborationRole="owner"
        cdpUrl={cdpUrl}
        shareUrls={shareUrls}
        onSessionDetails={() => actions.details(session)}
      />
    );
  }

  return (
    <div className="aperture:relative aperture:flex aperture:h-full aperture:min-h-0 aperture:flex-1 aperture:overflow-hidden aperture:bg-background">
      {navigation && session ? (
        <SessionSwitcher
          currentSessionId={session.id}
          pinned={switcherPinned}
          onPinnedChange={(pinned) => {
            saveSwitcherPinned(pinned);
            setSwitcherPinned(pinned);
          }}
          onNewSession={permissions.canWrite ? () => actions.newSession() : undefined}
        />
      ) : null}
      <div className="aperture:flex aperture:min-h-0 aperture:min-w-0 aperture:flex-1 aperture:flex-col aperture:overflow-hidden">
        {content}
      </div>
      {dialogs}
    </div>
  );
}

function WorkbenchActions({
  session,
  actions,
  permissions,
}: {
  session: Session;
  actions: ReturnType<typeof useSessionDialogs>["actions"];
  permissions: ReturnType<typeof useSessionDialogs>["permissions"];
}) {
  const proxyConfigured = isProxyConfigured(session.proxy);
  const proxySummary = describeProxy(session.proxy);

  return (
    <>
      {permissions.canSaveSnapshots && isSaveable(session.status) ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="aperture:h-7 aperture:px-2"
                aria-label="Save to snapshot"
                onClick={() => actions.saveToSnapshot(session)}
              />
            }
          >
            <Camera data-icon="inline-start" />
            <span className="aperture:max-xl:hidden">Save to snapshot</span>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Save this session's logins and browser state for new sessions
          </TooltipContent>
        </Tooltip>
      ) : null}
      {permissions.canWrite ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant={proxyConfigured ? "secondary" : "ghost"}
                size="icon-sm"
                className="aperture:relative"
                aria-label="Proxy"
                onClick={() => actions.editProxy(session)}
              />
            }
          >
            <Network />
            {proxyConfigured ? (
              <span className="aperture:absolute aperture:top-1 aperture:right-1 aperture:size-1.5 aperture:rounded-full aperture:bg-primary" />
            ) : null}
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {proxySummary ? `Proxy: ${proxySummary}` : "Proxy: direct connection"}
          </TooltipContent>
        </Tooltip>
      ) : null}
      <SessionActionsMenu
        session={session}
        actions={actions}
        permissions={permissions}
        trigger={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Actions for ${sessionLabel(session)}`}
            title={sessionLabel(session)}
          >
            <MoreHorizontal />
          </Button>
        }
      />
    </>
  );
}

function SwitcherToggle({ pinned, onToggle }: { pinned: boolean; onToggle: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn(
              "aperture:h-full aperture:aspect-square aperture:shrink-0 aperture:rounded-none",
              pinned && "aperture:bg-muted",
            )}
            aria-label={pinned ? "Hide session list" : "Show session list"}
            aria-pressed={pinned}
            onClick={onToggle}
          />
        }
      >
        <PanelLeft />
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {pinned ? "Hide session list" : "Session list (or hover the left edge)"}
      </TooltipContent>
    </Tooltip>
  );
}

function AllSessionsToolbarButton() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="All sessions"
            render={<Link to="/-/sessions" />}
            nativeButton={false}
          />
        }
      >
        <LayoutGrid />
      </TooltipTrigger>
      <TooltipContent side="bottom">All sessions</TooltipContent>
    </Tooltip>
  );
}

function AllSessionsButton() {
  return (
    <Button variant="outline" size="sm" render={<Link to="/-/sessions" />} nativeButton={false}>
      <LayoutGrid data-icon="inline-start" />
      All sessions
    </Button>
  );
}

function FullPageState({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <Empty className="aperture:h-full aperture:border-none">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {children ? (
        <EmptyContent className="aperture:flex-row aperture:justify-center">
          {children}
        </EmptyContent>
      ) : null}
    </Empty>
  );
}

/** True once the document has stayed hidden for `ms`; false again as soon as it shows. */
function useHiddenFor(ms: number) {
  const [hiddenLong, setHiddenLong] = useState(false);

  useEffect(() => {
    let timer: number | null = null;
    const update = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      if (document.visibilityState === "hidden") {
        timer = window.setTimeout(() => setHiddenLong(true), ms);
      } else {
        setHiddenLong(false);
      }
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [ms]);

  return hiddenLong;
}

/**
 * Applies `#target=<id>` and `?newTab` once the live session has its targets: the first selects
 * that tab, the second opens a new one. Both are cleared afterwards so a reload doesn't repeat
 * them.
 */
function useDeepLinkTargets(
  control: ReturnType<typeof useBrowserControl>,
  openNewTab: boolean,
  clear: () => void,
) {
  const handled = useRef(false);
  const connected = control.phase === "connected" && control.targets.length > 0;

  useEffect(() => {
    if (!connected || handled.current) {
      return;
    }
    const targetId = new URLSearchParams(window.location.hash.slice(1)).get("target");
    if (!openNewTab && !targetId) {
      return;
    }
    handled.current = true;
    if (openNewTab) {
      control.createTarget("about:blank");
    } else if (targetId && control.targets.some((target) => target.id === targetId)) {
      control.activateTarget(targetId);
    }
    clear();
  }, [connected, control, openNewTab, clear]);
}

function shareUrl(origin: string, token: string) {
  const url = new URL("/share/", origin);
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}
