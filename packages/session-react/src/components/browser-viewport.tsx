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
      className={className ?? "bg-background"}
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
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <ViewportPlaceholder placeholder={overlay.placeholder} />
        </div>
      ) : null}
      {statusBadge ? (
        <div className="pointer-events-none absolute right-2 bottom-2 flex items-center gap-1.5">
          <StatusBadge status={overlay.status} />
        </div>
      ) : null}
      {overlay.followedCursor ? (
        <div
          className="pointer-events-none absolute z-30 flex translate-x-[-2px] translate-y-[-2px] items-start text-primary drop-shadow-sm"
          style={{ left: overlay.followedCursor.x, top: overlay.followedCursor.y }}
        >
          <MousePointer2 className="size-5 fill-primary stroke-background stroke-[1.5]" />
          <span className="mt-4 -ml-1 rounded bg-primary px-1.5 py-0.5 text-[10px] leading-none font-medium whitespace-nowrap text-primary-foreground">
            {overlay.followedCursor.name}
          </span>
        </div>
      ) : null}
      {overlay.cursorHint ? (
        <div
          className="pointer-events-none absolute z-20 max-w-64 translate-x-3 translate-y-3 rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
          style={{ left: overlay.cursorHint.x, top: overlay.cursorHint.y }}
        >
          {overlay.cursorHint.text}
        </div>
      ) : null}
      {overlay.collaborationError ? (
        <div className="pointer-events-none absolute bottom-10 left-2 max-w-[80%] rounded-md border border-amber-500/40 bg-background/90 px-2 py-1 text-xs text-amber-800 dark:text-amber-300">
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
    <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
      {placeholder === "disconnected" ? (
        <Unplug className="size-5" />
      ) : (
        <Loader2 className="size-5 animate-spin" />
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
        className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      >
        {status}
      </Badge>
    );
  }
  return <Badge variant="outline">offline</Badge>;
}
