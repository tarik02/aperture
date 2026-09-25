import { useEffect, useMemo, useState, type ReactNode } from "react";
import * as Effect from "effect/Effect";
import { Link2Off, Loader2 } from "lucide-react";
import {
  SessionsApi,
  type ApiCredentials,
  type BrowserStatus,
  type IceServer,
} from "@aperture-browser/api-client";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@aperture-browser/ui/components/empty";
import { Toaster } from "@aperture-browser/ui/components/sonner";
import { TooltipProvider } from "@aperture-browser/ui/components/tooltip";
import { PortalContainerProvider } from "@aperture-browser/ui/portal";
import { cn } from "@aperture-browser/ui/utils";
import { BrowserControlPane } from "./components/browser-control-pane.tsx";
import { RuntimeProvider, useFork } from "./effect.tsx";
import { useBrowserControl } from "./hooks/use-browser-control.ts";
import { makeApertureRuntime, type ApertureRuntime } from "./runtime.ts";

/** What a share link's token grants: one session, as an editor or a viewer. */
export interface ShareToken {
  readonly token: string;
  readonly sessionId: string;
  readonly role: "editor" | "viewer";
}

/** Reads an editor (`ape_…`) or viewer (`apv_…`) share token; null if it is malformed. */
export function parseShareToken(token: string): ShareToken | null {
  const sessionId = token.slice(4, 40);
  const role = token.startsWith("ape_") ? "editor" : token.startsWith("apv_") ? "viewer" : null;
  if (!role || token[40] !== "_" || !sessionId || !token.slice(41)) {
    return null;
  }
  return { token, sessionId, role };
}

export interface SharedSessionProps {
  /** A share link's editor (`ape_…`) or viewer (`apv_…`) token. */
  readonly token: string;
  /** Shows the tab strip (default); without it only the active tab is shown. */
  readonly tabs?: boolean;
  /** Rendered at the start of the title bar. */
  readonly leading?: ReactNode;
}

export interface ApertureSessionProps extends SharedSessionProps {
  /** The Aperture instance the token belongs to; defaults to the page's own origin. */
  readonly baseUrl?: string;
  /** Light or dark colors; "system" (the default) follows the OS setting. */
  readonly theme?: "light" | "dark" | "system";
  /** Renders a toaster for the session's notifications (default). */
  readonly toaster?: boolean;
  /** Classes for the root element, which fills its container by default. */
  readonly className?: string;
}

/**
 * A shared Aperture session, ready to embed: it brings its own runtime, tooltips, toasts
 * and styling root (import `@aperture-browser/session-react/styles.css` once). Popups
 * render inside the root. Inside an app that already provides all of this, use
 * `SharedSession`.
 */
export function ApertureSession({
  baseUrl,
  theme = "system",
  toaster = true,
  className,
  ...props
}: ApertureSessionProps) {
  const [runtime, setRuntime] = useState<ApertureRuntime | null>(null);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const dark = useDarkTheme(theme);

  useEffect(() => {
    const created = makeApertureRuntime({ baseUrl });
    setRuntime(created);
    return () => {
      setRuntime(null);
      void created.dispose();
    };
  }, [baseUrl]);

  return (
    <div
      ref={setRoot}
      className={cn("aperture-root relative h-full w-full", dark && "dark", className)}
    >
      {runtime && root ? (
        <RuntimeProvider runtime={runtime} baseUrl={baseUrl}>
          <PortalContainerProvider container={root}>
            <TooltipProvider>
              <SharedSession {...props} />
              {toaster ? (
                <Toaster
                  theme={dark ? "dark" : "light"}
                  richColors
                  closeButton
                  position="bottom-center"
                />
              ) : null}
            </TooltipProvider>
          </PortalContainerProvider>
        </RuntimeProvider>
      ) : null}
    </div>
  );
}

function useDarkTheme(theme: "light" | "dark" | "system"): boolean {
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    if (theme !== "system") {
      return;
    }
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [theme]);

  return theme === "dark" || (theme === "system" && systemDark);
}

type StatusState =
  | { readonly kind: "loading" }
  | { readonly kind: "expired" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly status: BrowserStatus };

/** A shared session inside an app that provides the runtime and tooltips. */
export function SharedSession({ token, tabs, leading }: SharedSessionProps) {
  const share = useMemo(() => parseShareToken(token), [token]);
  const credentials = useMemo<ApiCredentials | null>(
    () =>
      share && {
        kind: "bearer",
        token: share.token,
        authorityType: null,
        tenantId: null,
        selectedTenantId: null,
      },
    [share],
  );
  const [state, setState] = useState<StatusState>({ kind: "loading" });

  useFork(
    () =>
      share && credentials
        ? Effect.sync(() => setState({ kind: "loading" })).pipe(
            Effect.andThen(
              SessionsApi.use((sessions) =>
                sessions.getBrowserStatus(credentials, share.sessionId),
              ),
            ),
            Effect.match({
              onFailure: (error) =>
                setState({ kind: error.status === 410 ? "expired" : "unavailable" }),
              onSuccess: (status) =>
                setState(
                  status.sessionId === share.sessionId
                    ? { kind: "ready", status }
                    : { kind: "unavailable" },
                ),
            }),
          )
        : undefined,
    [credentials, share],
  );

  if (!share || !credentials) {
    return (
      <SessionState
        icon={<Link2Off />}
        title="Invalid share link"
        description="This link does not contain a valid session capability."
      />
    );
  }

  switch (state.kind) {
    case "loading":
      return (
        <SessionState icon={<Loader2 className="animate-spin" />} title="Opening shared session" />
      );
    case "expired":
      return (
        <SessionState
          icon={<Link2Off />}
          title="Share link expired"
          description="This session capability has expired. Ask the session owner for a new link."
        />
      );
    case "unavailable":
      return (
        <SessionState
          icon={<Link2Off />}
          title="Shared session unavailable"
          description="This link is invalid, revoked, or the shared session is no longer available."
        />
      );
    case "ready":
      return (
        <SharedBrowser
          share={share}
          credentials={credentials}
          status={state.status}
          tabs={tabs}
          leading={leading}
        />
      );
  }
}

const emptyIceServers: readonly IceServer[] = [];

function SharedBrowser({
  share,
  credentials,
  status,
  tabs,
  leading,
}: {
  share: ShareToken;
  credentials: ApiCredentials;
  status: BrowserStatus;
  tabs?: boolean;
  leading?: ReactNode;
}) {
  const control = useBrowserControl({
    sessionId: share.sessionId,
    credentials,
    sessionToken: share.token,
    collaborationRole: share.role,
    webrtcProducerSupported: status.media.mode === "auto" && status.media.webrtcProducer,
    webrtcIceServers: status.media.iceServers ?? emptyIceServers,
  });

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <BrowserControlPane
        control={control}
        collaborationRole={share.role}
        // Share tokens never authorize CDP, so DevTools stays unavailable.
        cdpUrl={null}
        shareUrls={null}
        leading={leading}
        tabs={tabs}
      />
    </div>
  );
}

/** The DevTools endpoint for a session, authorized by `sessionToken` in its path. */
export function devToolsUrl(origin: string, cdpUrl: string, sessionToken: string): string {
  const sourceUrl = new URL(cdpUrl, origin);
  const url = new URL(origin);
  url.pathname = `${sourceUrl.pathname.replace(/\/$/, "")}/${encodeURIComponent(sessionToken)}`;
  return url.toString();
}

function SessionState({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
}) {
  return (
    <Empty className="h-full border-none">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
    </Empty>
  );
}
