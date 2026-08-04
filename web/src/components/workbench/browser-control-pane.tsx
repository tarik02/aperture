import { useState } from "react";
import type { UseBrowserControlResult } from "#/hooks/use-browser-control.ts";
import { BrowserToolbar } from "#/components/workbench/browser-toolbar.tsx";
import { BrowserViewport } from "#/components/workbench/browser-viewport.tsx";
import {
  BrowserDevToolsPane,
  type DevToolsDock,
} from "#/components/workbench/browser-devtools-pane.tsx";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "#/components/ui/resizable.tsx";

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
  const [devToolsOpen, setDevToolsOpen] = useState(false);
  const [devToolsDock, setDevToolsDock] = useState<DevToolsDock>("bottom");

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <BrowserToolbar
        control={control}
        guestMode={guestMode}
        cdpUrl={cdpUrl}
        shareUrl={shareUrl}
        performanceOverlayEnabled={performanceOverlayEnabled}
        onPerformanceOverlayChange={setPerformanceOverlayEnabled}
        devToolsOpen={devToolsOpen}
        devToolsDock={devToolsDock}
        onDevToolsOpenChange={setDevToolsOpen}
        onDevToolsDockChange={setDevToolsDock}
      />
      {devToolsOpen ? (
        <ResizablePanelGroup
          orientation={devToolsDock === "bottom" ? "vertical" : "horizontal"}
          className="min-h-0 min-w-0 flex-1"
        >
          <ResizablePanel className="flex min-h-0 min-w-0" defaultSize="60%" minSize="20%">
            <BrowserViewport
              control={control}
              viewport={control.viewport}
              performanceOverlayEnabled={performanceOverlayEnabled}
            />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel className="flex min-h-0 min-w-0" defaultSize="40%" minSize="20%">
            <BrowserDevToolsPane
              cdpUrl={cdpUrl}
              targetId={control.phase === "connected" ? control.activeTargetId : null}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <BrowserViewport
          control={control}
          viewport={control.viewport}
          performanceOverlayEnabled={performanceOverlayEnabled}
        />
      )}
    </div>
  );
}
