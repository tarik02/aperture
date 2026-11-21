import type { Session } from "@aperture-browser/session-client";
import { ApertureSession, type ApertureTheme } from "@aperture-browser/session-react";
import { Button } from "@aperture-browser/ui/components/button";
import { Link } from "@tanstack/react-router";
import { Spinner } from "@aperture-browser/ui/components/spinner";
import { useTheme } from "next-themes";
import { useEffect } from "react";
import { noteOpened } from "#/features/session/recent-sessions.ts";
import { useSessionActionMutation } from "#/features/session/session.mutations.ts";
import { useSessionQuery } from "#/features/session/session.queries.ts";
import { told } from "#/lib/api.ts";

function State({ children }: { children: React.ReactNode }) {
  return (
    <main
      data-console-session-note
      className="aperture:flex aperture:h-full aperture:flex-col aperture:items-center aperture:justify-center aperture:gap-3 aperture:p-4 aperture:text-sm aperture:text-muted-foreground"
    >
      {children}
      <Button variant="outline" render={<Link to="/-/sessions" />}>
        All sessions
      </Button>
    </main>
  );
}

declare global {
  interface Window {
    /** The session's client, for automation and tests. None while there is no connection. */
    apertureSession: Session | undefined;
  }
}

const expose = (session: Session | null) => {
  window.apertureSession = session ?? undefined;
};

const isTheme = (theme: string | undefined): theme is ApertureTheme =>
  theme === "light" || theme === "dark" || theme === "system";

/**
 * One session, opened: its workbench, connected at the session's path. The browser
 * carries what lets it in, and the proxy before the nodes turns that into a ticket.
 */
export function SessionWorkbench({ sessionId }: { sessionId: string }) {
  const session = useSessionQuery(sessionId);
  const resume = useSessionActionMutation("resume");
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    if (session.data !== undefined) {
      noteOpened(sessionId);
    }
  }, [session.data !== undefined, sessionId]);

  if (session.isError) {
    return <State>{told(session.error)}</State>;
  }
  if (session.data === undefined) {
    return null;
  }
  const { observedState, unreachableSince, failure } = session.data;
  if (session.data.path === null || observedState === "gone") {
    return <State>This session is on no node any more.</State>;
  }
  if (unreachableSince !== null) {
    return (
      <State>The session's node is out of reach. It is shown again when the node is back.</State>
    );
  }
  if (observedState === "failed") {
    return (
      <State>
        The session failed{failure === null ? "." : `: ${failure}`}
        <Button disabled={resume.isPending} onClick={() => resume.mutate(sessionId)}>
          Start again
        </Button>
      </State>
    );
  }
  if (session.data.desiredState === "suspended") {
    return (
      <State>
        This session is suspended.
        <Button disabled={resume.isPending} onClick={() => resume.mutate(sessionId)}>
          Resume
        </Button>
      </State>
    );
  }
  if (observedState === "starting" || observedState === "suspended") {
    return (
      <State>
        <Spinner />
        Starting…
      </State>
    );
  }
  // Connected anew when the session moves: its path is another then.
  return (
    <ApertureSession
      key={session.data.path}
      url={session.data.path}
      theme={isTheme(theme) ? theme : "system"}
      onThemeChange={setTheme}
      onSession={expose}
    />
  );
}
