import { useState } from "react";
import type { UseBrowserControlResult } from "#/hooks/use-browser-control.ts";
import { BrowserToolbar } from "#/components/workbench/browser-toolbar.tsx";
import { BrowserViewport } from "#/components/workbench/browser-viewport.tsx";

type BrowserControlPaneProps = {
  control: UseBrowserControlResult;
};

export function BrowserControlPane({ control }: BrowserControlPaneProps) {
  const [performanceOverlayEnabled, setPerformanceOverlayEnabled] = useState(false);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <BrowserToolbar
        control={control}
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
