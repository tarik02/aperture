import type { ReactNode } from "react";
import { Link2Off, Loader2 } from "lucide-react";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@aperture-browser/ui/components/empty";
import { Toaster } from "@aperture-browser/ui/components/sonner";
import { BrowserControlPane } from "./components/browser-control-pane.tsx";
import type { ApertureSessionFeatures, SessionFeatures } from "./features.ts";
import { showNotice } from "./notices.ts";
import { ApertureProvider } from "./provider.tsx";
import { useSession } from "./session.ts";
import { ApertureUIRoot, type ApertureTheme } from "./ui-root.tsx";
import type { SessionAccess } from "@aperture-browser/live-session";

export interface SessionProps {
  readonly access: SessionAccess | null;
  readonly features?: SessionFeatures;
  readonly leading?: ReactNode;
}

export interface ApertureSessionProps extends SessionProps {
  readonly features?: ApertureSessionFeatures;
  readonly theme?: ApertureTheme;
  readonly className?: string;
}

export function ApertureSession({ theme = "system", className, ...props }: ApertureSessionProps) {
  return (
    <ApertureUIRoot theme={theme} className={className}>
      <ApertureProvider baseUrl={props.access?.baseUrl}>
        <Session {...props} />
        {props.features?.toaster !== false ? (
          <Toaster theme={theme} richColors closeButton position="bottom-center" />
        ) : null}
      </ApertureProvider>
    </ApertureUIRoot>
  );
}

export function Session({ access, features, leading }: SessionProps) {
  const { status, control } = useSession({ access, onNotice: showNotice });

  switch (status) {
    case "invalid":
      return (
        <SessionState
          icon={<Link2Off />}
          title="Invalid session access"
          description="Provide a valid session connection."
        />
      );
    case "loading":
      return (
        <SessionState
          icon={<Loader2 className="aperture:animate-spin" />}
          title="Opening session"
        />
      );
    case "denied":
      return (
        <SessionState
          icon={<Link2Off />}
          title="Session access denied"
          description="Sign in to the app or ask for access to this session."
        />
      );
    case "expired":
      return (
        <SessionState
          icon={<Link2Off />}
          title="Session access expired"
          description="Ask the session owner to renew access."
        />
      );
    case "unavailable":
      return (
        <SessionState
          icon={<Link2Off />}
          title="Session unavailable"
          description="This session is unavailable or access has been revoked."
        />
      );
    case "ready":
      return (
        <div className="aperture:flex aperture:h-full aperture:min-h-0 aperture:flex-1 aperture:flex-col aperture:overflow-hidden aperture:bg-background">
          <BrowserControlPane
            control={control}
            collaborationRole={control.collaboration.role}
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
    <Empty className="aperture:h-full aperture:border-none">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
    </Empty>
  );
}
