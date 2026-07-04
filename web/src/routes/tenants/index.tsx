import { createFileRoute, Navigate } from "@tanstack/react-router";
import { Building2, MoreHorizontal, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { CreateTenantDialog } from "#/components/tenants/create-tenant-dialog.tsx";
import { EditTenantDialog } from "#/components/tenants/edit-tenant-dialog.tsx";
import { IncludeDeletedToggle } from "#/components/resources/include-deleted-toggle.tsx";
import { InfiniteTableShell } from "#/components/resources/infinite-table-shell.tsx";
import { DeletedBadge } from "#/components/resources/status-badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table.tsx";
import {
  useDeleteTenantMutation,
  useRestoreTenantMutation,
} from "#/hooks/mutations/use-tenant-mutations.ts";
import { useTenantsInfiniteQuery } from "#/hooks/queries/use-tenants-query.ts";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { formatTimestamp, truncateId } from "#/lib/format.ts";
import type { Tenant } from "#/lib/api/schemas.ts";
import { selectActiveProfile, useTokenVaultStore } from "#/stores/token-vault.ts";

export const Route = createFileRoute("/tenants/")({
  component: TenantsPage,
});

function TenantsPage() {
  const credentials = useApiCredentials();
  const activeProfile = useTokenVaultStore(selectActiveProfile);
  const setSelectedTenant = useTokenVaultStore((state) => state.setSelectedTenant);
  const hydrated = useTokenVaultStore((state) => state.hydrated);
  const bootstrapping = useTokenVaultStore((state) => state.bootstrapping);

  const [includeDeleted, setIncludeDeleted] = useState(false);
  const filters = useMemo(() => ({ includeDeleted }), [includeDeleted]);
  const query = useTenantsInfiniteQuery(filters);

  const [createOpen, setCreateOpen] = useState(false);
  const [editTenant, setEditTenant] = useState<Tenant | null>(null);

  const deleteMutation = useDeleteTenantMutation();
  const restoreMutation = useRestoreTenantMutation();

  if (hydrated && !bootstrapping && credentials?.authorityType !== "system_admin") {
    return <Navigate to="/" />;
  }

  function selectTenant(tenant: Tenant) {
    if (!activeProfile) {
      return;
    }
    setSelectedTenant(activeProfile.id, tenant.id, tenant.displayName);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Tenants</h1>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus />
          Create
        </Button>
      </div>

      <IncludeDeletedToggle checked={includeDeleted} onCheckedChange={setIncludeDeleted} />

      <InfiniteTableShell query={query} emptyTitle="No tenants">
        {(items) => (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>ID</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-24" />
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((tenant) => (
                <TableRow key={tenant.id}>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      {tenant.displayName}
                      <DeletedBadge deletedAt={tenant.deletedAt} />
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{truncateId(tenant.id, 10)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatTimestamp(tenant.createdAt)}
                  </TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => selectTenant(tenant)}
                    >
                      <Building2 />
                      Select
                    </Button>
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" />}>
                        <MoreHorizontal />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setEditTenant(tenant)}>
                          Rename
                        </DropdownMenuItem>
                        {tenant.deletedAt ? (
                          <DropdownMenuItem
                            onClick={() => void restoreMutation.mutateAsync(tenant.id)}
                          >
                            Restore
                          </DropdownMenuItem>
                        ) : (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() => void deleteMutation.mutateAsync(tenant.id)}
                            >
                              Delete
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </InfiniteTableShell>

      <CreateTenantDialog open={createOpen} onOpenChange={setCreateOpen} />

      <EditTenantDialog
        tenant={editTenant}
        open={editTenant !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditTenant(null);
          }
        }}
      />
    </div>
  );
}
