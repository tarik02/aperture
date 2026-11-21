import { ApertureSession } from "@aperture-browser/session-react";
import { Button } from "@aperture-browser/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { told } from "../../lib/api.ts";
import { sessionQuery } from "./queries.ts";

function Note({ children }: { children: React.ReactNode }) {
  return (
    <main className="aperture:flex aperture:h-full aperture:flex-col aperture:items-center aperture:justify-center aperture:gap-3 aperture:p-4 aperture:text-sm aperture:text-muted-foreground">
      {children}
      <Button variant="outline" render={<Link to="/" />}>
        All sessions
      </Button>
    </main>
  );
}

/**
 * One session, opened: its workbench, connected at the session's path. The browser
 * carries what lets it in, and the proxy before the nodes turns that into a ticket.
 */
export function SessionPage({ id }: { id: string }) {
  const session = useQuery(sessionQuery(id));

  if (session.isError) {
    return <Note>{told(session.error)}</Note>;
  }
  if (session.data === undefined) {
    return null;
  }
  if (session.data.path === null) {
    return <Note>This session is on no node.</Note>;
  }
  // Connected anew when the session moves: its path is another then.
  return <ApertureSession key={session.data.path} url={session.data.path} />;
}
