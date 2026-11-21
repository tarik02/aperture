import { Badge } from "@aperture-browser/ui/components/badge";
import type { Session } from "#/features/session/session.queries.ts";

/** What a session is, in a word: what its node last said, unless the node is out of reach. */
export function SessionStatusBadge({ session }: { session: Session }) {
  if (session.unreachableSince !== null) {
    return <Badge variant="destructive">out of reach</Badge>;
  }
  const state = session.observedState;
  return (
    <Badge
      data-console-session-state={state}
      variant={state === "running" ? "default" : state === "failed" ? "destructive" : "outline"}
    >
      {state}
    </Badge>
  );
}
