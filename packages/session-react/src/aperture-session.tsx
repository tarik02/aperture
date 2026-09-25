import { useEffect, useState, type ReactNode } from "react";
import { Link2Off, Loader2 } from "lucide-react";
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
import type { ApertureSessionFeatures, SessionFeatures } from "./features.ts";
import { showNotice } from "./notices.ts";
import { ApertureProvider } from "./provider.tsx";
import { useSharedSession } from "./shared-session.ts";

export interface SharedSessionProps {
  readonly token: string;
  readonly features?: SessionFeatures;
  readonly leading?: ReactNode;
}

export interface ApertureSessionProps extends SharedSessionProps {
  readonly baseUrl?: string;
  readonly features?: ApertureSessionFeatures;
  readonly theme?: "light" | "dark" | "system";
  readonly className?: string;
}

export function ApertureSession({
  baseUrl,
  theme = "system",
  className,
  ...props
}: ApertureSessionProps) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const dark = useDarkTheme(theme);

  return (
    <div
      ref={setRoot}
      className={cn("aperture-root relative h-full w-full", dark && "dark", className)}
    >
      {root ? (
        <ApertureProvider baseUrl={baseUrl}>
          <PortalContainerProvider container={root}>
            <TooltipProvider>
              <SharedSession {...props} />
              {props.features?.toaster !== false ? (
                <Toaster
                  theme={dark ? "dark" : "light"}
                  richColors
                  closeButton
                  position="bottom-center"
                />
              ) : null}
            </TooltipProvider>
          </PortalContainerProvider>
        </ApertureProvider>
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

export function SharedSession({ token, features, leading }: SharedSessionProps) {
  const { status, share, control } = useSharedSession({ token, onNotice: showNotice });

  switch (status) {
    case "invalid":
      return (
        <SessionState
          icon={<Link2Off />}
          title="Invalid share link"
          description="This link does not contain a valid session capability."
        />
      );
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
        <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background">
          <BrowserControlPane
            control={control}
            collaborationRole={share?.role ?? "viewer"}
            cdpUrl={null}
            shareUrls={null}
            leading={leading}
            features={{ devTools: false, ...features }}
          />
        </div>
      );
  }
}

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
