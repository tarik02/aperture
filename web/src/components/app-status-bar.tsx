import { useQuery } from "@tanstack/react-query";
import { Badge } from "#/components/ui/badge.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { SelectedTenantControl } from "#/components/selected-tenant-control.tsx";
import { fetchApiHealth } from "#/lib/auth-me.ts";
import { selectActiveProfile, useTokenVaultStore } from "#/stores/token-vault.ts";

function authorityLabel(authorityType: string | null): string {
  switch (authorityType) {
    case "system_admin":
      return "Admin";
    case "tenant":
      return "Tenant";
    default:
      return "No token";
  }
}

export function AppStatusBar() {
  const activeProfile = useTokenVaultStore(selectActiveProfile);
  const bootstrapping = useTokenVaultStore((state) => state.bootstrapping);

  const healthQuery = useQuery({
    queryKey: ["api-health"],
    queryFn: fetchApiHealth,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const healthLabel = healthQuery.isPending
    ? "API…"
    : healthQuery.data === "ok"
      ? "API ok"
      : "API down";

  const healthVariant = healthQuery.isPending
    ? "outline"
    : healthQuery.data === "ok"
      ? "secondary"
      : "destructive";

  const tokenLabel = activeProfile
    ? activeProfile.tokenName
      ? `${activeProfile.tokenName} · ${activeProfile.maskedTokenId}`
      : activeProfile.label
    : "No token";

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span className="truncate text-sm font-medium">Aperture</span>
      <div className="ml-auto flex items-center gap-2">
        <Badge variant={healthVariant}>{healthLabel}</Badge>
        <Badge variant={activeProfile ? "secondary" : "outline"}>
          {bootstrapping ? "Syncing…" : authorityLabel(activeProfile?.authorityType ?? null)}
        </Badge>
        {activeProfile ? (
          <Badge variant="outline" className="hidden max-w-40 truncate sm:inline-flex">
            {tokenLabel}
          </Badge>
        ) : null}
        <SelectedTenantControl />
        {bootstrapping ? <Skeleton className="hidden h-7 w-16 sm:block" /> : null}
      </div>
    </div>
  );
}
