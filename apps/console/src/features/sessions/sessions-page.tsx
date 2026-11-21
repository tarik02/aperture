import { Badge } from "@aperture-browser/ui/components/badge";
import { Button } from "@aperture-browser/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@aperture-browser/ui/components/table";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import { LogOut, Pause, Play, Plus, Trash2 } from "lucide-react";
import { forget, told } from "../../lib/api.ts";
import { keepToken } from "../../lib/token.ts";
import {
  accountQuery,
  type Session,
  sessionsQuery,
  useCreateSession,
  useSessionChange,
} from "./queries.ts";

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** What a session is, in a word: what its node last said, unless the node is out of reach. */
function SessionState({ session }: { session: Session }) {
  if (session.unreachableSince !== null) {
    return <Badge variant="destructive">out of reach</Badge>;
  }
  const state = session.observedState;
  return (
    <Badge
      variant={state === "running" ? "default" : state === "failed" ? "destructive" : "outline"}
    >
      {state}
    </Badge>
  );
}

function SessionRow({ session }: { session: Session }) {
  const suspend = useSessionChange("suspend");
  const resume = useSessionChange("resume");
  const remove = useSessionChange("delete");
  const busy = suspend.isPending || resume.isPending || remove.isPending;
  const suspended = session.desiredState === "suspended";

  return (
    <TableRow data-console-session={session.id}>
      <TableCell className="aperture:font-mono aperture:text-xs">
        <Link to="/sessions/$id" params={{ id: session.id }} className="aperture:hover:underline">
          {session.id}
        </Link>
      </TableCell>
      <TableCell>
        <SessionState session={session} />
      </TableCell>
      <TableCell className="aperture:text-muted-foreground">
        {when.format(DateTime.toDate(session.createdAt))}
      </TableCell>
      <TableCell className="aperture:text-right">
        <div className="aperture:flex aperture:justify-end aperture:gap-1">
          {suspended ? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Resume"
              disabled={busy || session.nodeId === null}
              onClick={() => resume.mutate(session.id)}
            >
              <Play />
            </Button>
          ) : (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Suspend"
              disabled={busy || session.nodeId === null}
              onClick={() => suspend.mutate(session.id)}
            >
              <Pause />
            </Button>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Delete"
            disabled={busy}
            onClick={() => remove.mutate(session.id)}
          >
            <Trash2 />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

/** An account's sessions, wherever they run. */
export function SessionsPage() {
  const account = useQuery(accountQuery);
  const sessions = useQuery(sessionsQuery);
  const create = useCreateSession();

  const signOut = () => {
    void forget();
    keepToken(undefined);
  };

  return (
    <main className="aperture:mx-auto aperture:flex aperture:h-full aperture:max-w-4xl aperture:flex-col aperture:gap-4 aperture:overflow-auto aperture:p-4">
      <header className="aperture:flex aperture:items-center aperture:gap-2">
        <h1 className="aperture:text-lg aperture:font-semibold">Sessions</h1>
        <span className="aperture:flex-1" />
        <span className="aperture:text-sm aperture:text-muted-foreground">
          {account.data?.name}
        </span>
        <Button size="icon-sm" variant="ghost" aria-label="Sign out" onClick={signOut}>
          <LogOut />
        </Button>
        <Button data-console-create disabled={create.isPending} onClick={() => create.mutate()}>
          <Plus />
          New session
        </Button>
      </header>
      {create.isError ? (
        <p role="alert" className="aperture:text-sm aperture:text-destructive">
          {told(create.error)}
        </p>
      ) : null}
      {sessions.isError ? (
        <p role="alert" className="aperture:text-sm aperture:text-destructive">
          {told(sessions.error)}
        </p>
      ) : null}
      {sessions.data?.length === 0 ? (
        <p
          data-console-empty
          className="aperture:py-12 aperture:text-center aperture:text-sm aperture:text-muted-foreground"
        >
          No sessions yet.
        </p>
      ) : (
        <Table scrollable={false}>
          <TableHeader>
            <TableRow>
              <TableHead>Session</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Created</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.data?.map((session) => (
              <SessionRow key={session.id} session={session} />
            ))}
          </TableBody>
        </Table>
      )}
    </main>
  );
}
