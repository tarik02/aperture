import { Loader2, MousePointer2, Unplug } from "lucide-react";
import { Badge } from "@aperture-browser/ui/components/badge";
import { showNotice } from "../notices.ts";
import {
  SessionViewport,
  type SessionViewportOverlay,
  type SessionViewportPlaceholder,
  type SessionViewportProps,
  type SessionViewportStatus,
} from "./session-viewport.tsx";

export interface BrowserViewportProps extends Omit<
  SessionViewportProps,
  "renderOverlay" | "onNotice"
> {
  statusBadge?: boolean;
}

export function BrowserViewport({ statusBadge = true, className, ...props }: BrowserViewportProps) {
  return (
    <SessionViewport
      {...props}
      className={className ?? "aperture:bg-background"}
      onNotice={showNotice}
      renderOverlay={(overlay) => <ViewportOverlay overlay={overlay} statusBadge={statusBadge} />}
    />
  );
}

function ViewportOverlay({
  overlay,
  statusBadge,
}: {
  overlay: SessionViewportOverlay;
  statusBadge: boolean;
}) {
  return (
    <>
      {overlay.placeholder ? (
        <div className="aperture:pointer-events-none aperture:absolute aperture:inset-0 aperture:flex aperture:items-center aperture:justify-center">
          <ViewportPlaceholder placeholder={overlay.placeholder} />
        </div>
      ) : null}
      {statusBadge ? (
        <div className="aperture:pointer-events-none aperture:absolute aperture:right-2 aperture:bottom-2 aperture:flex aperture:items-center aperture:gap-1.5">
          <StatusBadge status={overlay.status} />
        </div>
      ) : null}
      {overlay.followedCursor ? (
        <div
          className="aperture:pointer-events-none aperture:absolute aperture:z-30 aperture:flex aperture:translate-x-[-2px] aperture:translate-y-[-2px] aperture:items-start aperture:text-primary aperture:drop-shadow-sm"
          style={{ left: overlay.followedCursor.x, top: overlay.followedCursor.y }}
        >
          <MousePointer2 className="aperture:size-5 aperture:fill-primary aperture:stroke-background aperture:stroke-[1.5]" />
          <span className="aperture:mt-4 aperture:-ml-1 aperture:rounded aperture:bg-primary aperture:px-1.5 aperture:py-0.5 aperture:text-[10px] aperture:leading-none aperture:font-medium aperture:whitespace-nowrap aperture:text-primary-foreground">
            {overlay.followedCursor.name}
          </span>
        </div>
      ) : null}
      {overlay.cursorHint ? (
        <div
          className="aperture:pointer-events-none aperture:absolute aperture:z-20 aperture:max-w-64 aperture:translate-x-3 aperture:translate-y-3 aperture:rounded-md aperture:border aperture:bg-popover aperture:px-2 aperture:py-1 aperture:text-xs aperture:text-popover-foreground aperture:shadow-md"
          style={{ left: overlay.cursorHint.x, top: overlay.cursorHint.y }}
        >
          {overlay.cursorHint.text}
        </div>
      ) : null}
      {overlay.collaborationError ? (
        <div className="aperture:pointer-events-none aperture:absolute aperture:bottom-10 aperture:left-2 aperture:max-w-[80%] aperture:rounded-md aperture:border aperture:border-amber-500/40 aperture:bg-background/90 aperture:px-2 aperture:py-1 aperture:text-xs aperture:text-amber-800 aperture:dark:text-amber-300">
          {overlay.collaborationError}
        </div>
      ) : null}
    </>
  );
}

const placeholderLabels: Record<SessionViewportPlaceholder, string> = {
  connecting: "Connecting",
  "connecting-media": "Connecting media",
  switching: "Switching target",
  disconnected: "Disconnected",
  waiting: "Waiting for frame",
};

function ViewportPlaceholder({ placeholder }: { placeholder: SessionViewportPlaceholder }) {
  return (
    <div className="aperture:flex aperture:flex-col aperture:items-center aperture:gap-2 aperture:text-sm aperture:text-muted-foreground">
      {placeholder === "disconnected" ? (
        <Unplug className="aperture:size-5" />
      ) : (
        <Loader2 className="aperture:size-5 aperture:animate-spin" />
      )}
      {placeholderLabels[placeholder]}
    </div>
  );
}

function StatusBadge({ status }: { status: SessionViewportStatus }) {
  if (status === "webrtc" || status === "websocket") {
    return (
      <Badge
        variant="secondary"
        className="aperture:bg-emerald-500/15 aperture:text-emerald-700 aperture:dark:text-emerald-300"
      >
        {status}
      </Badge>
    );
  }
  return <Badge variant="outline">offline</Badge>;
}
