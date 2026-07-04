import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { TenantRequiredNotice } from "#/components/resources/tenant-required.tsx";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty.tsx";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "#/components/ui/resizable.tsx";
import { BrowserControlPane } from "#/components/workbench/browser-control-pane.tsx";
import { SessionInspectorPane } from "#/components/workbench/session-inspector-pane.tsx";
import { SessionListPane } from "#/components/workbench/session-list-pane.tsx";
import { useBrowserControl } from "#/hooks/use-browser-control.ts";
import { useWorkbenchSession } from "#/hooks/use-workbench-session.ts";
import { hasScope, useActiveScopes } from "#/hooks/use-scopes.ts";
import { isTenantScopedQueryReady, useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { AppWindow, Loader2 } from "lucide-react";

type SessionWorkbenchProps = {
  sessionId?: string;
};

export function SessionWorkbench({ sessionId }: SessionWorkbenchProps) {
  const credentials = useApiCredentials();
  const scopes = useActiveScopes();
  const navigate = useNavigate();
  const canControl = hasScope(scopes, "sessions:write");
  const tenantReady = isTenantScopedQueryReady(credentials);

  const [search, setSearch] = useState("");
  const {
    session: selectedSession,
    runningSessions,
    isResolvingRoute,
  } = useWorkbenchSession(sessionId);

  useEffect(() => {
    if (sessionId || !tenantReady || isResolvingRoute) {
      return;
    }
    const first = runningSessions[0];
    if (first) {
      void navigate({ to: "/sessions/$sessionId", params: { sessionId: first.id }, replace: true });
    }
  }, [sessionId, tenantReady, runningSessions, isResolvingRoute, navigate]);

  const control = useBrowserControl({
    sessionId: selectedSession?.status === "running" ? selectedSession.id : null,
    enabled: canControl && tenantReady && selectedSession?.status === "running",
  });

  if (!tenantReady) {
    return <TenantRequiredNotice />;
  }

  if (!canControl) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <AppWindow />
          </EmptyMedia>
          <EmptyTitle>sessions:write required</EmptyTitle>
          <EmptyDescription>
            Switch to a token with session write scope to control browsers.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="-m-3 flex min-h-0 flex-1 flex-col">
      <ResizablePanelGroup orientation="horizontal" className="min-h-[calc(100svh-3rem)]">
        <ResizablePanel defaultSize={18} minSize={14} maxSize={30}>
          <SessionListPane
            selectedSessionId={selectedSession?.id ?? null}
            search={search}
            onSearchChange={setSearch}
          />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={57} minSize={35}>
          {isResolvingRoute ? (
            <Empty className="h-full border-none">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Loader2 className="animate-spin" />
                </EmptyMedia>
                <EmptyTitle>Loading session</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : selectedSession ? (
            <BrowserControlPane control={control} />
          ) : (
            <Empty className="h-full border-none">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <AppWindow />
                </EmptyMedia>
                <EmptyTitle>No session selected</EmptyTitle>
                <EmptyDescription>Select a running session from the list.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={25} minSize={18} maxSize={35}>
          <SessionInspectorPane session={selectedSession} />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
