import type { ReactNode } from "react";
import { AppWindow, Eye, History, Loader2, Plus, RotateCcw, Unplug } from "lucide-react";
import { Badge } from "@aperture-browser/ui/components/badge";
import { Button } from "@aperture-browser/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@aperture-browser/ui/components/empty";
import { Spinner } from "@aperture-browser/ui/components/spinner";
import { cn } from "@aperture-browser/ui/utils";
import type { Restoring } from "@aperture-browser/session-client";
import { useLease, useReconnect, useSession, useSessionSnapshot } from "../session.tsx";
import { useWorkbench } from "../workbench/context.tsx";
import { WorkbenchSlot } from "../workbench/slot.tsx";
import { MemberMarks } from "./member-marks.tsx";
import { LeaseOverlay } from "./session-presence.tsx";
import { SessionViewport } from "./session-viewport.tsx";

export interface BrowserViewportProps {
  readonly className?: string | undefined;
}

/**
 * The picture with what the workbench lays over it: the connection's state, the lease, and
 * what is contributed to `viewport`.
 */
export function BrowserViewport({ className }: BrowserViewportProps) {
  const showLease = useWorkbench().features.presence;
  const session = useSession();
  const snapshot = useSessionSnapshot();
  const reconnect = useReconnect();
  const lease = useLease();
  const { connection } = snapshot;
  const watched = snapshot.targets.find((target) => target.tab === snapshot.selected);
  const open = connection.state === "open";

  return (
    <SessionViewport className={cn("aperture:bg-muted/40", className)}>
      {connection.state === "connecting" ? (
        <Placeholder>
          <Loader2 className="aperture:size-5 aperture:animate-spin" />
          Connecting to the session
        </Placeholder>
      ) : null}
      {connection.state === "closed" ? (
        <div className="aperture:absolute aperture:inset-0 aperture:z-20 aperture:flex aperture:items-center aperture:justify-center aperture:bg-background/80 aperture:backdrop-blur-sm">
          <Empty className="aperture:border-none" data-session-closed="">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Unplug />
              </EmptyMedia>
              <EmptyTitle>Disconnected from the session</EmptyTitle>
              <EmptyDescription>
                {connection.reason === undefined || connection.reason === ""
                  ? "The connection to the session closed."
                  : connection.reason}
              </EmptyDescription>
            </EmptyHeader>
            {reconnect === undefined ? null : (
              <EmptyContent>
                <Button type="button" size="sm" onClick={() => reconnect()}>
                  <RotateCcw />
                  Reconnect
                </Button>
              </EmptyContent>
            )}
          </Empty>
        </div>
      ) : null}
      {open && snapshot.restoring !== undefined ? (
        <Restored restoring={snapshot.restoring} />
      ) : null}
      {open && snapshot.restoring === undefined && snapshot.targets.length === 0 ? (
        <Empty
          className="aperture:absolute aperture:inset-0 aperture:border-none"
          data-session-empty=""
        >
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <AppWindow />
            </EmptyMedia>
            <EmptyTitle>No tabs</EmptyTitle>
            <EmptyDescription>The session's browser has no tab open.</EmptyDescription>
          </EmptyHeader>
          {snapshot.features.tabs.write ? (
            <EmptyContent>
              <Button type="button" size="sm" onClick={() => session.newTab()}>
                <Plus />
                New tab
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      ) : null}
      {open && snapshot.targets.length > 0 && watched === undefined ? (
        <Placeholder>
          <Loader2 className="aperture:size-5 aperture:animate-spin" />
          Waiting for a tab
        </Placeholder>
      ) : null}
      {open && showLease ? <MemberMarks /> : null}
      {open && showLease ? <LeaseOverlay /> : null}
      {open && showLease && lease.state === "view-only" ? (
        <div
          className={cn(
            "aperture:pointer-events-none aperture:absolute aperture:left-2 aperture:z-10",
            // A phone's bar is over the picture's foot.
            snapshot.phone ? "aperture:top-2" : "aperture:bottom-2",
          )}
        >
          <Badge variant="outline" className="aperture:bg-background/90" data-session-view-only="">
            <Eye />
            View only
          </Badge>
        </div>
      ) : null}
      <WorkbenchSlot name="viewport" />
    </SessionViewport>
  );
}

const counted = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/** What is being put into the session's browser, of what there is of each. */
const beingPut = ({ tabs, cookies, origins }: Restoring) =>
  [
    tabs > 0 ? counted(tabs, "tab", "tabs") : undefined,
    cookies > 0 ? counted(cookies, "cookie", "cookies") : undefined,
    origins > 0 ? `the storage of ${counted(origins, "site", "sites")}` : undefined,
  ].filter((part) => part !== undefined);

/**
 * Over the picture while the session is given what its browser starts with: the tabs are
 * seen to arrive behind it, and nothing is pressed through it, as a press on a page that
 * is not yet what it is to be is a wrong one. The session takes no input meanwhile either.
 */
function Restored({ restoring }: { restoring: Restoring }) {
  const parts = beingPut(restoring);
  const failed = restoring.failure !== undefined;
  return (
    <div
      data-session-restoring={failed ? "failed" : "underway"}
      className="aperture:absolute aperture:inset-0 aperture:z-20 aperture:flex aperture:items-center aperture:justify-center aperture:bg-background/60 aperture:backdrop-blur-[2px]"
    >
      <Empty className="aperture:max-w-sm aperture:flex-none aperture:rounded-xl aperture:border aperture:border-solid aperture:bg-card/95 aperture:shadow-sm">
        <EmptyHeader>
          <EmptyMedia variant="icon">{failed ? <History /> : <Spinner />}</EmptyMedia>
          <EmptyTitle>
            {failed ? "The session was not restored" : "Restoring the session"}
          </EmptyTitle>
          <EmptyDescription role={failed ? "alert" : "status"}>
            {failed
              ? restoring.failure
              : parts.length === 0
                ? "What its browser starts with is on its way."
                : `Putting in ${parts.join(", ")}.`}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}

function Placeholder({ children }: { children: ReactNode }) {
  return (
    <div className="aperture:pointer-events-none aperture:absolute aperture:inset-0 aperture:flex aperture:flex-col aperture:items-center aperture:justify-center aperture:gap-2 aperture:text-sm aperture:text-muted-foreground">
      {children}
    </div>
  );
}
