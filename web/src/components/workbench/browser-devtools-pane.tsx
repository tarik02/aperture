import { useMemo } from "react";
import { Wrench } from "lucide-react";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty.tsx";

export type DevToolsDock = "bottom" | "right";

type BrowserDevToolsPaneProps = {
  cdpUrl: string | null;
  targetId: string | null;
};

export function BrowserDevToolsPane({ cdpUrl, targetId }: BrowserDevToolsPaneProps) {
  const src = useMemo(() => {
    if (!cdpUrl || !targetId) {
      return null;
    }

    const cdp = new URL(cdpUrl);
    const cdpPath = cdp.pathname.replace(/\/$/, "");
    const frame = new URL(`${cdpPath}/devtools/devtools_app.html`, cdp.origin);
    const socket = `${cdp.host}${cdpPath}/devtools/page/${encodeURIComponent(targetId)}`;
    frame.searchParams.set(cdp.protocol === "https:" ? "wss" : "ws", socket);
    return frame.toString();
  }, [cdpUrl, targetId]);

  if (!src) {
    return (
      <Empty className="h-full rounded-none border-none">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Wrench />
          </EmptyMedia>
          <EmptyTitle>DevTools unavailable</EmptyTitle>
          <EmptyDescription>Connect to a browser target to inspect it.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <iframe
      className="h-full w-full border-0 bg-background"
      src={src}
      title="Browser DevTools"
      allow="clipboard-read; clipboard-write"
      referrerPolicy="no-referrer"
    />
  );
}
