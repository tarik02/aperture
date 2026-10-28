import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { usePanelRef } from "react-resizable-panels";
import type { UseBrowserControlResult } from "../hooks/use-browser-control.ts";
import type { CollaborationRole } from "@aperture-browser/live-session";
import { resolveSessionFeatures, type SessionFeatures } from "../features.ts";
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
  /** Rendered at the start of the title bar row, before the tab strip. */
  leading?: ReactNode;
  /** Rendered at the end of the title bar row, after the participants. */
  trailing?: ReactNode;
  /** Rendered at the start of the toolbar row, before the navigation buttons. */
  toolbarLeading?: ReactNode;
  /** Rendered at the end of the toolbar row, before the browser menu. */
  toolbarTrailing?: ReactNode;
  features?: SessionFeatures;
  collaborationRole: CollaborationRole;
  cdpUrl: string | null;
  shareUrls: { editor: string; viewer: string } | null;
  onSessionDetails?: () => void;
  /** Extra items at the top of the browser menu, such as actions on the session. */
  menuItems?: ReactNode;
  /** Extra items in the menu's "Share and connect" submenu. */
  shareMenuItems?: ReactNode;
  /** Items at the end of the browser menu, such as deleting the session. */
  menuFooterItems?: ReactNode;
  /**
   * The icon Aperture captured for a tab, null for none, or undefined while unknown. Without it
   * tabs load the site's own `/favicon.ico`.
   */
  targetFaviconUrl?: (targetId: string) => string | null | undefined;
};

const LOCAL_CURSOR_STORAGE_KEY = "aperture.workbench.localCursorEnabled";

export function BrowserControlPane({
  control,
  leading,
  trailing,
  toolbarLeading,
  toolbarTrailing,
  features: featureOverrides,
  collaborationRole,
  cdpUrl,
  shareUrls,
  onSessionDetails,
  menuItems,
  shareMenuItems,
  menuFooterItems,
  targetFaviconUrl,
}: BrowserControlPaneProps) {
  const features = resolveSessionFeatures(featureOverrides);
  const [localCursorEnabled, setLocalCursorEnabled] = useState(true);
  const [paintingEnabled, setPaintingEnabled] = useState(false);
  const [devToolsTargetIds, setDevToolsTargetIds] = useState<ReadonlySet<string>>(() => new Set());
  const [devToolsDock, setDevToolsDock] = useState<DevToolsDock>("bottom");
  const devToolsPanelRef = usePanelRef();
  const activeTargetId = control.activeTargetId;
  const devToolsOpen =
    features.devTools && activeTargetId !== null && devToolsTargetIds.has(activeTargetId);

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

  const viewport = (
    <BrowserViewport
      control={control}
      viewport={control.viewport}
      localCursorEnabled={localCursorEnabled}
      paintingEnabled={features.drawing && paintingEnabled}
      onPaintingEnabledChange={setPaintingEnabled}
      statusBadge={features.statusBadge}
    />
  );

  return (
    <div className="aperture:flex aperture:h-full aperture:min-h-0 aperture:min-w-0 aperture:flex-1 aperture:flex-col aperture:overflow-hidden">
      <BrowserToolbar
        control={control}
        leading={leading}
        trailing={trailing}
        toolbarLeading={toolbarLeading}
        toolbarTrailing={toolbarTrailing}
        features={features}
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
        menuItems={menuItems}
        shareMenuItems={shareMenuItems}
        menuFooterItems={menuFooterItems}
        targetFaviconUrl={targetFaviconUrl}
      />
      {features.devTools ? (
        <ResizablePanelGroup
          orientation={devToolsDock === "bottom" ? "vertical" : "horizontal"}
          className="aperture:min-h-0 aperture:min-w-0 aperture:flex-1 aperture:has-[[data-separator=active]]:[&_iframe]:pointer-events-none"
        >
          <ResizablePanel
            className="aperture:flex aperture:min-h-0 aperture:min-w-0"
            defaultSize="60%"
            minSize="20%"
          >
            {viewport}
          </ResizablePanel>
          <ResizableHandle withHandle disabled={!devToolsOpen} hidden={!devToolsOpen} />
          <ResizablePanel
            panelRef={devToolsPanelRef}
            className="aperture:flex aperture:min-h-0 aperture:min-w-0"
            collapsible
            defaultSize="40%"
            minSize="20%"
          >
            {Array.from(devToolsTargetIds, (targetId) => (
              <div
                key={targetId}
                className="aperture:h-full aperture:min-h-0 aperture:w-full aperture:min-w-0"
                hidden={targetId !== activeTargetId}
              >
                <BrowserDevToolsPane cdpUrl={cdpUrl} targetId={targetId} />
              </div>
            ))}
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        viewport
      )}
    </div>
  );
}
