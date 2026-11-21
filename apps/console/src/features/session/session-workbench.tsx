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
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  type SessionAction,
  SessionActionsSubmenu,
  useSessionActions,
} from "#/features/session/session-actions-menu.tsx";
import { useNewSession } from "#/features/session/new-sessions.ts";
import { WorkbenchSkeleton } from "#/features/session/workbench-skeleton.tsx";
import { useDocumentTitle } from "#/lib/document-title.ts";
import { openedPicture } from "#/lib/view-transition.ts";
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

/** What a session showed last, behind what is said of it; nothing where it has no picture. */
function Backdrop({ source }: { source: string }) {
  const [missing, setMissing] = useState<string>();
  return missing === source ? null : (
    <img
      alt=""
      aria-hidden
      src={source}
      onError={() => setMissing(source)}
      className="aperture:absolute aperture:inset-0 aperture:size-full aperture:scale-105 aperture:object-cover aperture:object-top aperture:opacity-40 aperture:blur-md"
    />
  );
}

/** Why a session's workbench is not shown, in the workbench's place. */
function State({ children, note, session, action }: StateProps) {
  return (
    <main
      data-console-session-note={note ?? ""}
      className="aperture:relative aperture:flex aperture:min-h-0 aperture:flex-1 aperture:items-center aperture:justify-center aperture:overflow-hidden aperture:p-4"
    >
      {/* The way to the sidebar, which the workbench's title bar has and this has not. */}
      <SidebarTrigger
        data-console-sidebar-trigger
        className="aperture:absolute aperture:top-[max(0.5rem,env(safe-area-inset-top))] aperture:left-[max(0.5rem,env(safe-area-inset-left))] aperture:z-10"
      />
      {session === undefined || session.path === null ? null : (
        <Backdrop
          source={`${session.path}/preview.png?at=${session.observedAt.epochMilliseconds}`}
        />
      )}
      <section className="aperture:relative aperture:flex aperture:w-full aperture:max-w-sm aperture:flex-col aperture:items-center aperture:gap-4 aperture:rounded-xl aperture:border aperture:bg-card/90 aperture:p-6 aperture:text-center aperture:shadow-sm aperture:backdrop-blur">
        {session === undefined ? null : (
          <h1 className="aperture:max-w-full aperture:text-base aperture:font-semibold aperture:wrap-anywhere">
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

/** What is done with the session that is open, for the workbench's own menu. */
const Actions = createContext<ReadonlyArray<SessionAction>>([]);

/**
 * What the console adds to the workbench. The way to the sidebar, which has no title bar
 * of the console's here: it stands before the tabs, where a narrow window and a finger
 * find it as well. And what is done with the session, in the browser's menu.
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
  {
    id: "console.session",
    slot: "menu.browser",
    group: "console.session",
    order: 50,
    component: function SessionItems() {
      return <SessionActionsSubmenu actions={useContext(Actions)} />;
    },
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

const idle = () => () => undefined;

/** How long a session may take to draw itself before what stands in for it steps aside. */
const DRAWN_WITHIN_MS = 15_000;

/**
 * Whether the workbench below has a picture of the session, or has said why it has none:
 * then nothing stands in for it any more. Asked anew for each place the session is at.
 */
function useDrawn(workbench: React.RefObject<HTMLElement | null>, path: string | null) {
  const [drawn, setDrawn] = useState<string | null>(null);
  useEffect(() => {
    const element = workbench.current;
    if (element === null || path === null) {
      return undefined;
    }
    const look = () => {
      if (element.querySelector("[data-aperture-drawn], [data-session-closed]") !== null) {
        setDrawn(path);
      }
    };
    look();
    const changes = new MutationObserver(look);
    changes.observe(element, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-aperture-drawn", "data-session-closed"],
    });
    const late = setTimeout(() => setDrawn(path), DRAWN_WITHIN_MS);
    return () => {
      changes.disconnect();
      clearTimeout(late);
    };
    // The element is there once the session's record is, which gives the path.
  }, [workbench, path]);
  return drawn !== null && drawn === path;
}

/**
 * One session, opened: its workbench, connected at the session's path. The browser
 * carries what lets it in, and the proxy before the nodes turns that into a ticket.
 */
export function SessionWorkbench({ sessionId }: { sessionId: string }) {
  const session = useSessionQuery(sessionId);
  const resume = useSessionActionMutation("resume");
  const workbench = useRef<HTMLDivElement>(null);
  const [client, setClient] = useState<Session | null>(null);
  const watch = useCallback((opened: Session | null) => {
    expose(opened);
    setClient(opened);
  }, []);
  // The tab is named after the page that is watched; after the session until there is one.
  const watched = useSyncExternalStore(
    client?.subscribe ?? idle,
    () =>
      client?.getSnapshot().targets.find((target) => target.tab === client.getSnapshot().selected)
        ?.title,
  );
  useDocumentTitle(watched || (session.data?.label ?? "Session"));
  const drawn = useDrawn(workbench, session.data?.path ?? null);

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
    return <State note="missing">{told(session.error, "The session was not looked up.")}</State>;
  }
  if (session.data === undefined) {
    // Its card's picture moves into this one's place while the session is asked for.
    return <WorkbenchSkeleton picture={openedPicture(sessionId)} />;
  }
  // What it was opened from, or what it showed when it last rested.
  const kept =
    openedPicture(sessionId) ??
    (session.data.path === null
      ? undefined
      : `${session.data.path}/preview.png?at=${session.data.observedAt.epochMilliseconds}`);
  const { observedState, unreachableSince, failure } = session.data;
  // Asked to run: what follows is the wait for it, whatever the record still says.
  const starting = resume.isPending || resume.isSuccess;
  const { path } = session.data;
  if (path === null || observedState === "gone") {
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
      <WorkbenchSkeleton note="starting" picture={kept}>
        Starting…
      </WorkbenchSkeleton>
    );
  }
  return (
    <Running
      session={{ ...session.data, path }}
      workbench={workbench}
      drawn={drawn}
      kept={kept}
      watch={watch}
    />
  );
}

type RunningProps = {
  session: SessionRecord & { path: string };
  workbench: React.RefObject<HTMLDivElement | null>;
  drawn: boolean;
  kept: string | undefined;
  watch: (opened: Session | null) => void;
};

/** The session's workbench, with what is done with the session in its menu. */
function Running({ session, workbench, drawn, kept, watch }: RunningProps) {
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const { actions, dialogs } = useSessionActions(
    session,
    () => void navigate({ to: "/-/sessions" }),
  );
  // Connected anew when the session moves: its path is another then.
  return (
    <div
      ref={workbench}
      className="aperture:relative aperture:flex aperture:min-h-0 aperture:flex-1 aperture:flex-col"
    >
      <Actions.Provider value={actions}>
        <ApertureSession
          key={session.path}
          url={session.path}
          theme={isTheme(theme) ? theme : "system"}
          onThemeChange={setTheme}
          onSession={watch}
          contributions={CONTRIBUTIONS}
        />
      </Actions.Provider>
      {/* Until the session draws itself: no empty picture between the two. */}
      {drawn ? null : <WorkbenchSkeleton over note="connecting" picture={kept} />}
      {dialogs}
    </div>
  );
}
