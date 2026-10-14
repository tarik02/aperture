import { useState } from "react";
import { Building2 } from "lucide-react";
import { Button } from "@aperture-browser/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@aperture-browser/ui/components/empty";
import { PersonalTenantModal } from "#/features/tenant/personal-tenant-modal.tsx";
import { selectAuth, useAuthSessionStore } from "#/stores/auth-session.ts";

/** Shown in place of a tenant-scoped page while the user has no tenant selected. */
export function NoTenantState() {
  const auth = useAuthSessionStore(selectAuth);
  const [personalTenantOpen, setPersonalTenantOpen] = useState(false);

  const canPick = (auth?.availableTenants.length ?? 0) > 0;
  const personalTenant = auth?.personalTenant ?? null;

  return (
    <div className="aperture:flex aperture:h-full aperture:items-center aperture:justify-center aperture:p-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Building2 />
          </EmptyMedia>
          <EmptyTitle>{canPick ? "No tenant selected" : "No tenant yet"}</EmptyTitle>
          <EmptyDescription>
            {canPick
              ? "Sessions, snapshots and tokens belong to a tenant. Pick one in the sidebar."
              : personalTenant
                ? "Sessions, snapshots and tokens belong to a tenant. Set up a personal tenant of your own, or ask an administrator for access to a shared one."
                : "Sessions, snapshots and tokens belong to a tenant. Ask an administrator for access to one."}
          </EmptyDescription>
        </EmptyHeader>
        {!canPick && personalTenant ? (
          <EmptyContent>
            <Button type="button" onClick={() => setPersonalTenantOpen(true)}>
              <Building2 data-icon="inline-start" />
              Personal tenant
            </Button>
          </EmptyContent>
        ) : null}
      </Empty>
      {personalTenant ? (
        <PersonalTenantModal open={personalTenantOpen} onOpenChange={setPersonalTenantOpen} />
      ) : null}
    </div>
  );
}
