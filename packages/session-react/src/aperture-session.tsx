import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import type { ConnectOptions, Session } from "@aperture-browser/session-client";
import { Toaster } from "@aperture-browser/ui/components/sonner";
import { SessionWorkbench, type SessionWorkbenchProps } from "./components/session-workbench.tsx";
import type { ApertureSessionFeatures } from "./features.ts";
import { SessionProvider, useConnectedSession } from "./session.tsx";
import { ApertureUIRoot, type ApertureTheme } from "./ui-root.tsx";

export interface ApertureSessionProps
  extends ConnectOptions, Omit<SessionWorkbenchProps, "features" | "appearance" | "children"> {
  readonly features?: ApertureSessionFeatures | undefined;
  readonly theme?: ApertureTheme | undefined;
  /** With it, the browser menu offers to change the theme. */
  readonly onThemeChange?: ((theme: ApertureTheme) => void) | undefined;
  readonly className?: string | undefined;
  /** Hears of the session's client when there is one, and of none when it is closed. */
  readonly onSession?: ((session: Session | null) => void) | undefined;
}

/**
 * The workbench of one session: connects to it, shows it, and ends the connection when
 * unmounted. Needs `@aperture-browser/session-react/styles.css`.
 */
export function ApertureSession({
  url,
  token,
  name,
  pixels,
  features,
  theme = "system",
  onThemeChange,
  className,
  onSession,
  ...workbench
}: ApertureSessionProps) {
  const { session, reconnect } = useConnectedSession({ url, token, name, pixels });

  useEffect(() => {
    if (session === null || onSession === undefined) {
      return undefined;
    }
    onSession(session);
    // Also when the component is unmounted, which no later render tells.
    return () => onSession(null);
  }, [onSession, session]);

  return (
    <ApertureUIRoot theme={theme} className={className}>
      {session === null ? (
        <div className="aperture:flex aperture:h-full aperture:flex-col aperture:items-center aperture:justify-center aperture:gap-2 aperture:bg-background aperture:text-sm aperture:text-muted-foreground">
          <Loader2 className="aperture:size-5 aperture:animate-spin" />
          Connecting to the session
        </div>
      ) : (
        <SessionProvider session={session} reconnect={reconnect}>
          <SessionWorkbench
            {...workbench}
            features={features}
            appearance={onThemeChange === undefined ? undefined : { theme, onThemeChange }}
          />
        </SessionProvider>
      )}
      {features?.toaster === false ? null : (
        <Toaster
          theme={theme}
          richColors
          closeButton
          position="bottom-center"
          // Above the bar a phone's workbench has over its foot, and the keyboard.
          mobileOffset={{
            bottom: "calc(var(--keyboard-inset, 0px) + env(safe-area-inset-bottom, 0px) + 4.5rem)",
          }}
        />
      )}
    </ApertureUIRoot>
  );
}
