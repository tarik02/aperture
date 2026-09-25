import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { usePanelRef } from "react-resizable-panels";
import type { UseBrowserControlResult } from "../hooks/use-browser-control.ts";
import type { CollaborationRole } from "@aperture-browser/live-session";
import { BrowserToolbar } from "./browser-toolbar.tsx";
import { BrowserViewport } from "./browser-viewport.tsx";
import { BrowserDevToolsPane, type DevToolsDock } from "./browser-devtools-pane.tsx";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@aperture-browser/ui/components/resizable";

type BrowserControlPaneProps = {
  control: UseBrowserControlResult;
  /** Rendered at the start of the title bar, e.g. a link back to the host app. */
  leading?: ReactNode;
  /** Shows the tab strip (default); without it the pane shows the active tab only. */
  tabs?: boolean;
  collaborationRole: CollaborationRole;
  cdpUrl: string | null;
  shareUrls: { editor: string; viewer: string } | null;
  onSessionDetails?: () => void;
};

const LOCAL_CURSOR_STORAGE_KEY = "aperture.workbench.localCursorEnabled";

export function BrowserControlPane({
  control,
  leading,
  tabs = true,
  collaborationRole,
  cdpUrl,
  shareUrls,
  onSessionDetails,
}: BrowserControlPaneProps) {
  const [localCursorEnabled, setLocalCursorEnabled] = useState(true);
  const [paintingEnabled, setPaintingEnabled] = useState(false);
  const [devToolsTargetIds, setDevToolsTargetIds] = useState<ReadonlySet<string>>(() => new Set());
  const [devToolsDock, setDevToolsDock] = useState<DevToolsDock>("bottom");
  const devToolsPanelRef = usePanelRef();
  const activeTargetId = control.activeTargetId;
  const devToolsOpen = activeTargetId !== null && devToolsTargetIds.has(activeTargetId);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(LOCAL_CURSOR_STORAGE_KEY);
      if (stored === "false") {
        setLocalCursorEnabled(false);
      }
    } catch {
      // Local cursor remains enabled when storage is unavailable.
    }
  }, []);

  useEffect(() => {
    const targetIds = new Set(control.targets.map((target) => target.id));
    setDevToolsTargetIds((current) => {
      let changed = false;
      const next = new Set<string>();

      for (const targetId of current) {
        if (targetIds.has(targetId)) {
          next.add(targetId);
        } else {
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [control.targets]);

  useLayoutEffect(() => {
    if (devToolsOpen) {
      devToolsPanelRef.current?.expand();
    } else {
      devToolsPanelRef.current?.collapse();
    }
  }, [devToolsOpen, devToolsPanelRef]);

  function handleDevToolsOpenChange(open: boolean) {
    if (!activeTargetId) {
      return;
    }

    setDevToolsTargetIds((current) => {
      const next = new Set(current);
      if (open) {
        next.add(activeTargetId);
      } else {
        next.delete(activeTargetId);
      }
      return next;
    });
  }

  function handleLocalCursorChange(enabled: boolean) {
    setLocalCursorEnabled(enabled);
    try {
      window.localStorage.setItem(LOCAL_CURSOR_STORAGE_KEY, String(enabled));
    } catch {
      // Keep the preference for this page when storage is unavailable.
    }
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <BrowserToolbar
        control={control}
        leading={leading}
        tabs={tabs}
        collaborationRole={collaborationRole}
        cdpUrl={cdpUrl}
        shareUrls={shareUrls}
        localCursorEnabled={localCursorEnabled}
        onLocalCursorChange={handleLocalCursorChange}
        paintingEnabled={paintingEnabled}
        onPaintingEnabledChange={setPaintingEnabled}
        devToolsOpen={devToolsOpen}
        devToolsTargetIds={devToolsTargetIds}
        devToolsDock={devToolsDock}
        onDevToolsOpenChange={handleDevToolsOpenChange}
        onDevToolsDockChange={setDevToolsDock}
        onSessionDetails={onSessionDetails}
      />
      <ResizablePanelGroup
        orientation={devToolsDock === "bottom" ? "vertical" : "horizontal"}
        className="min-h-0 min-w-0 flex-1 has-[[data-separator=active]]:[&_iframe]:pointer-events-none"
      >
        <ResizablePanel className="flex min-h-0 min-w-0" defaultSize="60%" minSize="20%">
          <BrowserViewport
            control={control}
            viewport={control.viewport}
            localCursorEnabled={localCursorEnabled}
            paintingEnabled={paintingEnabled}
            onPaintingEnabledChange={setPaintingEnabled}
          />
        </ResizablePanel>
        <ResizableHandle withHandle disabled={!devToolsOpen} hidden={!devToolsOpen} />
        <ResizablePanel
          panelRef={devToolsPanelRef}
          className="flex min-h-0 min-w-0"
          collapsible
          defaultSize="40%"
          minSize="20%"
        >
          {Array.from(devToolsTargetIds, (targetId) => (
            <div
              key={targetId}
              className="h-full min-h-0 w-full min-w-0"
              hidden={targetId !== activeTargetId}
            >
              <BrowserDevToolsPane cdpUrl={cdpUrl} targetId={targetId} />
            </div>
          ))}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
