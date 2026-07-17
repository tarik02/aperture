import { useState } from "react";
import type { UseBrowserControlResult } from "#/hooks/use-browser-control.ts";
import { BrowserToolbar } from "#/components/workbench/browser-toolbar.tsx";
import { BrowserViewport } from "#/components/workbench/browser-viewport.tsx";

type BrowserControlPaneProps = {
  control: UseBrowserControlResult;
  guestMode?: boolean;
  cdpUrl: string | null;
  shareUrl: string | null;
};

export function BrowserControlPane({
  control,
  guestMode = false,
  cdpUrl,
  shareUrl,
}: BrowserControlPaneProps) {
  const [performanceOverlayEnabled, setPerformanceOverlayEnabled] = useState(false);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <BrowserToolbar
        control={control}
        guestMode={guestMode}
        cdpUrl={cdpUrl}
        shareUrl={shareUrl}
        performanceOverlayEnabled={performanceOverlayEnabled}
        onPerformanceOverlayChange={setPerformanceOverlayEnabled}
      />
      <BrowserViewport
        control={control}
        viewport={control.viewport}
        performanceOverlayEnabled={performanceOverlayEnabled}
      />
    </div>
  );
}
