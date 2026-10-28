import type { SessionAccess } from "@aperture-browser/live-session";
import { useIsMutating } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import * as Redacted from "effect/Redacted";
import { AppWindow, FolderOpen, LayoutGrid, RotateCcw } from "lucide-react";
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
import { useAnnounceOpenSession } from "#/features/session/open-sessions.ts";
import { useRecentSessionsStore } from "#/features/session/recent-sessions.store.ts";
import {
  SessionActionItems,
  type SessionActionKey,
} from "#/features/session/session-actions-menu.tsx";
import {
  useSessionDialogs,
  type SessionActions,
  type SessionPermissions,
} from "#/features/session/session-dialogs.tsx";
import { useBrowserStatusQuery, useSessionQuery } from "#/features/session/session.queries.ts";
import {
  saveToSnapshotMutationKey,
  type SaveToSnapshotInput,
} from "#/features/session/session.mutations.ts";
import { isReopenable, targetFaviconUrl } from "#/features/session/session-display.ts";
import { EdgePanel, loadPinned, savePinned } from "#/features/workbench/edge-panel.tsx";
import { SessionFilesPanel } from "#/features/workbench/files/session-files-panel.tsx";
import { selectAuth, useAuthSessionStore } from "#/stores/auth-session.ts";

type SessionWorkbenchProps = {
  sessionId: string;
  /** Stream frames over the session socket instead of WebRTC. */
  media?: "cdp";
  /** Open a new browser tab once connected. */
  openNewTab?: boolean;
  /**
   * Link to the rest of the app: "All sessions" buttons, and leaving for the session list once
   * the session is deleted. An embedded workbench turns this off and keeps the session's own
   * actions.
   */
  navigation?: boolean;
  /** Rendered at the start of the title bar, such as the host's sidebar toggle. */
  leading?: ReactNode;
};

const emptyIceServers: readonly IceServer[] = [];
/** How long a hidden tab keeps its live connection before letting it go. */
const hiddenDisconnectMs = 30_000;

/**
 * The workbench layout. It stays mounted while switching sessions, so the files panel and open
 * dialogs survive; only the connection to the browser is per session. It has no app chrome of its
 * own, so a host can place it anywhere.
 */
export function SessionWorkbench({
  sessionId,
  media,
  openNewTab = false,
  navigation = true,
  leading,
}: SessionWorkbenchProps) {
  const navigate = useNavigate();
  const session = useSessionQuery(sessionId).data ?? null;
  const [filesPinned, setFilesPinned] = useState(false);
  const { actions, dialogs, permissions } = useSessionDialogs({
    currentSessionId: sessionId,
    onSessionDeleted: () => {
      if (navigation) {
        void navigate({ to: "/-/sessions" });
      }
    },
  });

  useEffect(() => {
    setFilesPinned(loadPinned(filesPinnedKey));
  }, []);

  const changeFilesPinned = (pinned: boolean) => {
    savePinned(filesPinnedKey, pinned);
    setFilesPinned(pinned);
  };

  return (
    <div className="aperture:relative aperture:flex aperture:h-full aperture:min-h-0 aperture:flex-1 aperture:overflow-hidden aperture:bg-background">
      <WorkbenchSession
        key={sessionId}
        sessionId={sessionId}
        media={media}
        openNewTab={openNewTab}
        navigation={navigation}
        actions={actions}
        permissions={permissions}
        leading={leading}
        filesToggle={
          <FilesToggle pinned={filesPinned} onToggle={() => changeFilesPinned(!filesPinned)} />
        }
      />
      {session && isRetained(session.status) ? (
        <EdgePanel side="right" pinned={filesPinned} className="aperture:w-80">
          {() => <SessionFilesPanel session={session} />}
        </EdgePanel>
      ) : null}
      {dialogs}
    </div>
  );
}

const filesPinnedKey = "aperture.workbench.filesPinned";

function isRetained(status: Session["status"]) {
  return status !== "deleted" && status !== "expired";
}

type WorkbenchSessionProps = Required<Omit<SessionWorkbenchProps, "media" | "leading">> & {
  media?: "cdp";
  actions: SessionActions;
  permissions: SessionPermissions;
  leading: ReactNode;
  filesToggle: ReactNode;
};

/** One session: its connection, toolbar and full-page states. */
function WorkbenchSession({
  sessionId,
  media,
  openNewTab,
  navigation,
  actions,
  permissions,
  leading,
  filesToggle,
}: WorkbenchSessionProps) {
  const navigate = useNavigate();
  const credentials = useApiCredentials();
  const auth = useAuthSessionStore(selectAuth);
  const { selectTenant, switching } = useTenantSelection();
  const tenantReady = isTenantScopedQueryReady(credentials);
  const recordRecentSession = useRecentSessionsStore((state) => state.recordSession);
  const {
    session,
    provisional,
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
    enabled:
      permissions.canWrite && tenantReady && connectable && !provisional && !hiddenLong && !saving,
    webrtcProducerSupported:
      media !== "cdp" && session?.media.mode === "auto" && session.media.webrtcProducer,
    webrtcIceServers: session?.media.iceServers ?? emptyIceServers,
    onNotice: showNotice,
  });

  // The page listing names each tab's captured icon; tabs show those instead of loading the sites'.
  const statusEnabled = connectable && !provisional;
  const statusQuery = useBrowserStatusQuery(session, {
    enabled: statusEnabled,
    interval: faviconPollMs,
  });
  // refetch() runs even for a disabled query, so it is only passed while the listing is enabled.
  useRefetchOnTabChange(control.targets, statusEnabled ? statusQuery.refetch : null);
  const statusPages = statusQuery.data?.pages;
  const tabFavicon = useMemo(() => {
    if (!session?.favicon) {
      return undefined;
    }
    const pages = new Map(statusPages?.map((page) => [page.targetId, page]));
    const liveUrls = new Map(control.targets.map((target) => [target.id, target.url]));
    // A tab missing from the listing, or listed on another site than it shows now, isn't known
    // yet, so the tab strip uses its fallback until the listing catches up.
    return (targetId: string) => {
      const page = pages.get(targetId);
      if (!page || siteOf(page.url) !== siteOf(liveUrls.get(targetId) ?? "")) {
        return undefined;
      }
      return targetFaviconUrl(session, page);
    };
  }, [session, statusPages, control.targets]);

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
    const menuProps = { session, actions, permissions, exclude: workbenchMenuExcludes };
    content = (
      <BrowserControlPane
        key={session.id}
        control={control}
        leading={leading}
        trailing={filesToggle}
        menuItems={<SessionActionItems part="primary" {...menuProps} />}
        shareMenuItems={<SessionActionItems part="share" {...menuProps} />}
        menuFooterItems={<SessionActionItems part="closing" {...menuProps} />}
        targetFaviconUrl={tabFavicon}
        collaborationRole="owner"
        cdpUrl={cdpUrl}
        shareUrls={shareUrls}
        onSessionDetails={() => actions.details(session)}
      />
    );
  }

  return (
    <div className="aperture:flex aperture:min-h-0 aperture:min-w-0 aperture:flex-1 aperture:flex-col aperture:overflow-hidden">
      {content}
    </div>
  );
}

// The browser menu has its own details and viewer link items.
const workbenchMenuExcludes: ReadonlySet<SessionActionKey> = new Set(["details", "viewer-link"]);

/** Pins or unpins the files panel; hovering the right edge shows it either way. */
function FilesToggle({ pinned, onToggle }: { pinned: boolean; onToggle: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn(
              "aperture:h-full aperture:w-auto aperture:aspect-square aperture:shrink-0 aperture:rounded-none",
              pinned && "aperture:bg-muted",
            )}
            aria-label={pinned ? "Hide files" : "Show files"}
            aria-pressed={pinned}
            onClick={onToggle}
          />
        }
      >
        <FolderOpen />
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {pinned ? "Hide files" : "Show files (or hover the right edge)"}
      </TooltipContent>
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

function siteOf(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** The live connection reports tabs; the listing is only polled slowly for icons that change. */
const faviconPollMs = 60_000;
/**
 * After tabs open or navigate, the browser captures their icons in the background, a few seconds
 * after a listing asks; the listing is read again until a typical page load has had time.
 */
const faviconRefetchDelaysMs = [2_000, 8_000, 15_000];

function useRefetchOnTabChange(
  targets: ReturnType<typeof useBrowserControl>["targets"],
  refetch: (() => unknown) | null,
) {
  const signature = targets.map((target) => `${target.id} ${target.url}`).join("\n");
  useEffect(() => {
    if (signature === "" || refetch === null) {
      return;
    }
    const timers = faviconRefetchDelaysMs.map((delay) =>
      window.setTimeout(() => void refetch(), delay),
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [signature, refetch]);
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
