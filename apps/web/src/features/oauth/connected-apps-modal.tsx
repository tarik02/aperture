import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppWindow, Unplug } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "#/components/resources/confirm-dialog.tsx";
import { Badge } from "@aperture-browser/ui/components/badge";
import { Button } from "@aperture-browser/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@aperture-browser/ui/components/empty";
import { Skeleton } from "@aperture-browser/ui/components/skeleton";
import { OAuthClientAvatar } from "#/features/oauth/oauth-client-avatar.tsx";
import { queryKeys } from "#/lib/api/query-keys.ts";
import { formatTimestamp } from "#/lib/format.ts";
import { scopeLabel } from "#/lib/scopes.ts";
import { AuthApi, type OAuthGrant } from "@aperture-browser/api-client";
import { useRunApi } from "@aperture-browser/session-react";

interface ConnectedAppsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ConnectedAppsModal({ open, onOpenChange }: ConnectedAppsModalProps) {
  const runApi = useRunApi();
  const queryClient = useQueryClient();
  const grants = useQuery({
    queryKey: queryKeys.oauthGrants,
    queryFn: ({ signal }) =>
      runApi(
        AuthApi.use((auth) => auth.listOAuthGrants()),
        { signal },
      ),
    enabled: open,
  });
  const [revokeTarget, setRevokeTarget] = useState<OAuthGrant | null>(null);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);

  async function handleRevoke() {
    if (!revokeTarget) {
      return;
    }

    setRevoking(true);
    try {
      await runApi(AuthApi.use((auth) => auth.revokeOAuthGrant(revokeTarget.id)));
      await queryClient.invalidateQueries({ queryKey: queryKeys.oauthGrants });
      toast.success("Access revoked");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Revoking access failed");
      throw error;
    } finally {
      setRevoking(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="aperture:sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Connected apps</DialogTitle>
            <DialogDescription>Apps you allowed to use Aperture on your behalf.</DialogDescription>
          </DialogHeader>

          {grants.isPending ? (
            <div className="aperture:flex aperture:flex-col aperture:gap-2">
              <Skeleton className="aperture:h-20 aperture:w-full" />
              <Skeleton className="aperture:h-20 aperture:w-full" />
            </div>
          ) : grants.isError ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Could not load connected apps</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : grants.data.grants.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <AppWindow />
                </EmptyMedia>
                <EmptyTitle>No connected apps</EmptyTitle>
                <EmptyDescription>
                  Apps appear here after you approve their access request.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="aperture:flex aperture:max-h-[60vh] aperture:flex-col aperture:divide-y aperture:overflow-y-auto">
              {grants.data.grants.map((grant) => (
                <div
                  key={grant.id}
                  className="aperture:flex aperture:items-start aperture:gap-3 aperture:py-3"
                >
                  <OAuthClientAvatar client={grant.client} />
                  <div className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:flex-col aperture:gap-1">
                    <div className="aperture:truncate aperture:font-medium">
                      {grant.client.name}
                    </div>
                    <GrantAccessSummary grant={grant} />
                    <div className="aperture:text-xs aperture:text-muted-foreground">
                      Authorized {formatTimestamp(grant.createdAt)} ·{" "}
                      {grant.lastUsedAt !== null
                        ? `last used ${formatTimestamp(grant.lastUsedAt)}`
                        : "never used"}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={revoking}
                    onClick={() => {
                      setRevokeTarget(grant);
                      setRevokeOpen(true);
                    }}
                  >
                    <Unplug />
                    <span className="aperture:sr-only">Revoke {grant.client.name}</span>
                  </Button>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {revokeTarget ? (
        <ConfirmDialog
          open={revokeOpen}
          title="Revoke access"
          description={`Revoke ${revokeTarget.client.name}'s access to Aperture? It will need to be authorized again.`}
          confirmLabel="Revoke"
          pending={revoking}
          variant="destructive"
          onOpenChange={setRevokeOpen}
          onConfirm={handleRevoke}
        />
      ) : null}
    </>
  );
}

function GrantAccessSummary({ grant }: { grant: OAuthGrant }) {
  if (grant.authorityType === "system_admin") {
    return (
      <div>
        <Badge variant="destructive" className="aperture:font-normal">
          Full system administrator
        </Badge>
      </div>
    );
  }

  return (
    <div className="aperture:flex aperture:flex-col aperture:gap-1 aperture:text-xs aperture:text-muted-foreground">
      <span className="aperture:truncate">
        {grant.tenants.map((tenant) => tenant.displayName).join(", ")}
      </span>
      <div className="aperture:flex aperture:flex-wrap aperture:gap-1">
        {grant.scopes.map((scope) => (
          <Badge key={scope} variant="secondary" className="aperture:font-normal">
            {scopeLabel(scope)}
          </Badge>
        ))}
        {grant.resourceMode === "allowlist" ? (
          <Badge variant="outline" className="aperture:font-normal">
            {grant.resourceGrants.length === 1
              ? "1 resource"
              : `${grant.resourceGrants.length} resources`}
          </Badge>
        ) : null}
      </div>
    </div>
  );
}
