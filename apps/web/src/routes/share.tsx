import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Link2Off, Loader2 } from "lucide-react";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@aperture-browser/ui/components/empty";
import { parseShareToken, SharedSession } from "@aperture-browser/session-react";

const capabilityStorageKey = "aperture.share.session-token";

type CapabilityState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "ready"; token: string; revision: number };

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
        if (!parseShareToken(fragmentToken)) {
          window.sessionStorage.removeItem(capabilityStorageKey);
          setCapability({ kind: "invalid" });
          return;
        }
        window.sessionStorage.setItem(capabilityStorageKey, fragmentToken);
        revision += 1;
        setCapability({ kind: "ready", token: fragmentToken, revision });
        return;
      }

      const storedToken = window.sessionStorage.getItem(capabilityStorageKey);
      if (!storedToken) {
        setCapability({ kind: "missing" });
        return;
      }
      if (!parseShareToken(storedToken)) {
        window.sessionStorage.removeItem(capabilityStorageKey);
        setCapability({ kind: "invalid" });
        return;
      }
      revision += 1;
      setCapability({ kind: "ready", token: storedToken, revision });
    };

    loadCapability();
    window.addEventListener("hashchange", loadCapability);
    return () => window.removeEventListener("hashchange", loadCapability);
  }, []);

  if (capability.kind === "loading") {
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

  return <SharedSession key={capability.revision} token={capability.token} />;
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
