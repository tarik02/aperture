import type { ReactNode } from "react";
import { AppWindow, Eye, Loader2, Plus, RotateCcw, Unplug } from "lucide-react";
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
import { cn } from "@aperture-browser/ui/utils";
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
      {open && snapshot.targets.length === 0 ? (
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
        <div className="aperture:pointer-events-none aperture:absolute aperture:bottom-2 aperture:left-2 aperture:z-10">
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

function Placeholder({ children }: { children: ReactNode }) {
  return (
    <div className="aperture:pointer-events-none aperture:absolute aperture:inset-0 aperture:flex aperture:flex-col aperture:items-center aperture:justify-center aperture:gap-2 aperture:text-sm aperture:text-muted-foreground">
      {children}
    </div>
  );
}
