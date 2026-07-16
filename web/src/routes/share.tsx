import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link2Off, Loader2 } from "lucide-react";
import { SessionWorkbench } from "#/components/workbench/session-workbench.tsx";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty.tsx";
import { apiClient, type ApiCredentials } from "#/lib/api/client.ts";
import { ApiRequestError } from "#/lib/api/errors.ts";
import { queryKeys } from "#/lib/api/query-keys.ts";

const capabilityStorageKey = "aperture.share.cdp-token";

type CapabilityState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "ready"; token: string; sessionId: string; revision: number };

export const Route = createFileRoute("/share")({
  component: ShareRoute,
});

function ShareRoute() {
  const [capability, setCapability] = useState<CapabilityState>({ kind: "loading" });

  useEffect(() => {
    let revision = 0;
    const loadCapability = () => {
      const fragmentToken = new URLSearchParams(window.location.hash.slice(1)).get("token");
      if (window.location.hash) {
        window.history.replaceState(
          window.history.state,
          "",
          `${window.location.pathname}${window.location.search}`,
        );
        if (!fragmentToken) {
          window.sessionStorage.removeItem(capabilityStorageKey);
          setCapability({ kind: "invalid" });
          return;
        }
        const sessionId = parseCapabilitySessionId(fragmentToken);
        if (!sessionId) {
          window.sessionStorage.removeItem(capabilityStorageKey);
          setCapability({ kind: "invalid" });
          return;
        }
        window.sessionStorage.setItem(capabilityStorageKey, fragmentToken);
        revision += 1;
        setCapability({ kind: "ready", token: fragmentToken, sessionId, revision });
        return;
      }

      const storedToken = window.sessionStorage.getItem(capabilityStorageKey);
      if (!storedToken) {
        setCapability({ kind: "missing" });
        return;
      }
      const sessionId = parseCapabilitySessionId(storedToken);
      if (!sessionId) {
        window.sessionStorage.removeItem(capabilityStorageKey);
        setCapability({ kind: "invalid" });
        return;
      }
      revision += 1;
      setCapability({ kind: "ready", token: storedToken, sessionId, revision });
    };

    loadCapability();
    window.addEventListener("hashchange", loadCapability);
    return () => window.removeEventListener("hashchange", loadCapability);
  }, []);

  const credentials = useMemo<ApiCredentials | null>(
    () =>
      capability.kind === "ready"
        ? {
            token: capability.token,
            authorityType: null,
            tenantId: null,
            selectedTenantId: null,
          }
        : null,
    [capability],
  );
  const statusQuery = useQuery({
    queryKey: queryKeys.browserStatus(
      capability.kind === "ready" ? capability.sessionId : "none",
      capability.kind === "ready" ? capability.revision : 0,
    ),
    queryFn: () => {
      if (capability.kind !== "ready" || !credentials) {
        throw new Error("Session capability unavailable");
      }
      return apiClient.getBrowserStatus(credentials, capability.sessionId);
    },
    enabled: capability.kind === "ready" && credentials !== null,
    retry: false,
  });

  if (capability.kind === "loading" || statusQuery.isLoading) {
    return (
      <ShareState icon={<Loader2 className="animate-spin" />} title="Opening shared session" />
    );
  }

  if (capability.kind === "missing" || capability.kind === "invalid") {
    return (
      <ShareState
        icon={<Link2Off />}
        title="Invalid share link"
        description="This link does not contain a valid session capability."
      />
    );
  }

  if (
    !credentials ||
    statusQuery.isError ||
    !statusQuery.data ||
    statusQuery.data.sessionId !== capability.sessionId
  ) {
    const expired =
      statusQuery.error instanceof ApiRequestError && statusQuery.error.status === 410;
    return (
      <ShareState
        icon={<Link2Off />}
        title={expired ? "Share link expired" : "Shared session unavailable"}
        description={
          expired
            ? "This session capability has expired. Ask the session owner for a new link."
            : "This link is invalid, revoked, or the shared session is no longer available."
        }
      />
    );
  }

  return (
    <SessionWorkbench
      sessionId={capability.sessionId}
      capability={{
        credentials,
        session: {
          id: capability.sessionId,
          status: "running",
          media: statusQuery.data.media,
          cdpUrl: statusQuery.data.cdpUrl,
          cdpToken: capability.token,
        },
      }}
    />
  );
}

function ShareState({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
}) {
  return (
    <Empty className="h-full border-none">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
    </Empty>
  );
}

function parseCapabilitySessionId(token: string): string | null {
  const sessionId = token.slice(4, 40);
  if (!token.startsWith("cdp_") || token[40] !== "_" || !sessionId || !token.slice(41)) {
    return null;
  }
  return sessionId;
}
