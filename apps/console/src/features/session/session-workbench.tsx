import type { Session } from "@aperture-browser/session-client";
import {
  ApertureSession,
  type ApertureTheme,
  type WorkbenchContribution,
} from "@aperture-browser/session-react";
import { Button } from "@aperture-browser/ui/components/button";
import { SidebarTrigger } from "@aperture-browser/ui/components/sidebar";
import { Link, useNavigate } from "@tanstack/react-router";
import { useTheme } from "next-themes";
import { useEffect } from "react";
import { useNewSession } from "#/features/session/new-sessions.ts";
import { WorkbenchSkeleton } from "#/features/session/workbench-skeleton.tsx";
import { sessionPictureName } from "#/lib/view-transition.ts";
import { noteOpened } from "#/features/session/recent-sessions.ts";
import { useSessionActionMutation } from "#/features/session/session.mutations.ts";
import {
  type Session as SessionRecord,
  useSessionQuery,
} from "#/features/session/session.queries.ts";
import { told } from "#/lib/api.ts";

type StateProps = {
  children: React.ReactNode;
  note?: string;
  /** The session it is of, where there is one: what it showed last stands behind. */
  session?: SessionRecord | undefined;
  /** What is done about it, before the way back. */
  action?: React.ReactNode;
};

/** Why a session's workbench is not shown, in the workbench's place. */
function State({ children, note, session, action }: StateProps) {
  return (
    <main
      data-console-session-note={note ?? ""}
      className="aperture:relative aperture:flex aperture:min-h-0 aperture:flex-1 aperture:items-center aperture:justify-center aperture:overflow-hidden aperture:p-4"
    >
      {session === undefined || session.path === null ? null : (
        <img
          alt=""
          aria-hidden
          src={`${session.path}/preview.png?at=${session.observedAt.epochMilliseconds}`}
          // One that has no picture shows none.
          onError={(event) => event.currentTarget.remove()}
          className="aperture:absolute aperture:inset-0 aperture:size-full aperture:scale-105 aperture:object-cover aperture:object-top aperture:opacity-40 aperture:blur-md"
        />
      )}
      <section className="aperture:relative aperture:flex aperture:w-full aperture:max-w-sm aperture:flex-col aperture:items-center aperture:gap-4 aperture:rounded-xl aperture:border aperture:bg-card/90 aperture:p-6 aperture:text-center aperture:shadow-sm aperture:backdrop-blur">
        {session === undefined ? null : (
          <h1 className="aperture:max-w-full aperture:truncate aperture:text-base aperture:font-semibold">
            {session.label ?? "Session"}
          </h1>
        )}
        <div className="aperture:flex aperture:flex-col aperture:items-center aperture:gap-2 aperture:text-sm aperture:text-muted-foreground">
          {children}
        </div>
        <div className="aperture:flex aperture:gap-2">
          {action}
          <Button variant="outline" render={<Link to="/-/sessions" />}>
            All sessions
          </Button>
        </div>
      </section>
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

/**
 * The way to the sidebar from the workbench, which has no title bar of the console's: it
 * stands before the tabs, where a narrow window and a finger find it as well.
 */
const CONTRIBUTIONS: ReadonlyArray<WorkbenchContribution> = [
  {
    id: "console.sidebar",
    slot: "titlebar.start",
    component: () => (
      <SidebarTrigger
        data-console-sidebar-trigger
        className="aperture:aspect-square aperture:h-full aperture:w-auto aperture:shrink-0 aperture:rounded-none"
      />
    ),
  },
];

const isTheme = (theme: string | undefined): theme is ApertureTheme =>
  theme === "light" || theme === "dark" || theme === "system";

/**
 * A session that was asked for a moment ago, before it is there: it starts, and the address
 * becomes the session's own once it has one. Going back does not lead here again.
 */
export function NewSessionWorkbench({ sessionKey }: { sessionKey: string }) {
  const asked = useNewSession(sessionKey);
  const navigate = useNavigate();
  const made = asked?.state === "made" ? asked.id : undefined;

  useEffect(() => {
    if (made !== undefined) {
      void navigate({ to: "/-/sessions/$sessionId", params: { sessionId: made }, replace: true });
    }
  }, [made, navigate]);

  if (asked === undefined) {
    return <State>This session was asked for on a page that is gone.</State>;
  }
  if (asked.state === "failed") {
    return (
      <State note="failed">
        <span role="alert" className="aperture:text-destructive">
          The session was not created: {told(asked.error)}
        </span>
      </State>
    );
  }
  return <WorkbenchSkeleton note="asked">Starting…</WorkbenchSkeleton>;
}

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

  // It runs: asking it to is done with, and a later rest is told as one.
  const runs = session.data?.observedState === "running";
  useEffect(() => {
    if (runs) {
      resume.reset();
    }
  }, [runs, resume.reset]);

  if (session.isError) {
    return <State>{told(session.error)}</State>;
  }
  if (session.data === undefined) {
    // Its card's picture moves into this one's place while the session is asked for.
    return <WorkbenchSkeleton sessionId={sessionId} />;
  }
  const kept =
    session.data.path === null
      ? undefined
      : `${session.data.path}/preview.png?at=${session.data.observedAt.epochMilliseconds}`;
  const { observedState, unreachableSince, failure } = session.data;
  // Asked to run: what follows is the wait for it, whatever the record still says.
  const starting = resume.isPending || resume.isSuccess;
  if (session.data.path === null || observedState === "gone") {
    return <State session={session.data}>This session is on no node any more.</State>;
  }
  if (unreachableSince !== null) {
    return (
      <State session={session.data} note="unreachable">
        The session's node is out of reach. It is shown again when the node is back.
      </State>
    );
  }
  if (observedState === "failed" && !starting) {
    return (
      <State
        session={session.data}
        note="failed"
        action={<Button onClick={() => resume.mutate(sessionId)}>Start again</Button>}
      >
        The session failed{failure === null ? "." : `: ${failure}`}
      </State>
    );
  }
  if (session.data.desiredState === "suspended" && !starting) {
    return (
      <State
        session={session.data}
        note="suspended"
        action={
          <Button data-console-resume onClick={() => resume.mutate(sessionId)}>
            Resume
          </Button>
        }
      >
        Suspended
      </State>
    );
  }
  if (observedState !== "running") {
    return (
      <WorkbenchSkeleton note="starting" picture={kept} sessionId={sessionId}>
        Starting…
      </WorkbenchSkeleton>
    );
  }
  // Connected anew when the session moves: its path is another then.
  return (
    <div
      className="aperture:flex aperture:min-h-0 aperture:flex-1 aperture:flex-col"
      style={{
        viewTransitionName: sessionPictureName(sessionId),
        viewTransitionClass: "session-picture",
      }}
    >
      <ApertureSession
        key={session.data.path}
        url={session.data.path}
        theme={isTheme(theme) ? theme : "system"}
        onThemeChange={setTheme}
        onSession={expose}
        contributions={CONTRIBUTIONS}
      />
    </div>
  );
}
