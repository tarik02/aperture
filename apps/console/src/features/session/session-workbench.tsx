import { ApertureSession, type ApertureTheme } from "@aperture-browser/session-react";
import { Button } from "@aperture-browser/ui/components/button";
import { Link } from "@tanstack/react-router";
import { useTheme } from "next-themes";
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

  if (session.isError) {
    return <State>{told(session.error)}</State>;
  }
  if (session.data === undefined) {
    return null;
  }
  if (session.data.path === null) {
    return <State>This session is on no node.</State>;
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
  // Connected anew when the session moves: its path is another then.
  return (
    <ApertureSession
      key={session.data.path}
      url={session.data.path}
      theme={isTheme(theme) ? theme : "system"}
      onThemeChange={setTheme}
    />
  );
}
