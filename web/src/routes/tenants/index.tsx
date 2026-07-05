import { createFileRoute, Navigate } from "@tanstack/react-router";
import { Building2, MoreHorizontal, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { PageHeaderActions } from "#/components/page-header-actions.tsx";
import { CreateTenantDialog } from "#/components/tenants/create-tenant-dialog.tsx";
import { EditTenantDialog } from "#/components/tenants/edit-tenant-dialog.tsx";
import { BatchActionBar } from "#/components/resources/batch-action-bar.tsx";
import { DeletedStatusSelect } from "#/components/resources/deleted-status-select.tsx";
import {
  InfiniteTableShell,
  TableSkeletonRows,
} from "#/components/resources/infinite-table-shell.tsx";
import { DeletedBadge } from "#/components/resources/status-badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Checkbox } from "#/components/ui/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
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
  stickyTableEndCellClassName,
  stickyTableEndHeaderClassName,
  stickyTableStartCellClassName,
  stickyTableStartHeaderClassName,
} from "#/components/ui/table.tsx";
import {
  useDeleteTenantMutation,
  useRestoreTenantMutation,
} from "#/hooks/mutations/use-tenant-mutations.ts";
import { useTenantsInfiniteQuery } from "#/hooks/queries/use-tenants-query.ts";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { formatTimestamp } from "#/lib/format.ts";
import type { DeletedFilterValue } from "#/hooks/queries/keys.ts";
import type { Tenant } from "#/lib/api/schemas.ts";
import { selectActiveProfile, useTokenVaultStore } from "#/stores/token-vault.ts";

export const Route = createFileRoute("/tenants/")({
  component: TenantsPage,
});

const TENANT_SKELETON_COLUMNS = [
  {
    cellClassName: stickyTableStartCellClassName,
    skeletonClassName: "size-4 rounded-sm",
    sticky: "start",
  },
  { skeletonClassName: "h-4 w-44" },
  { skeletonClassName: "h-4 w-72" },
  { skeletonClassName: "h-4 w-36" },
  {
    cellClassName: stickyTableEndCellClassName,
    skeletonClassName: "ml-auto size-7",
    sticky: "end",
  },
] as const;

function TenantsPage() {
  const credentials = useApiCredentials();
  const activeProfile = useTokenVaultStore(selectActiveProfile);
  const setSelectedTenant = useTokenVaultStore((state) => state.setSelectedTenant);
  const hydrated = useTokenVaultStore((state) => state.hydrated);
  const bootstrapping = useTokenVaultStore((state) => state.bootstrapping);

  const [deleted, setDeleted] = useState<DeletedFilterValue>("active");
  const filters = useMemo(() => ({ includeDeleted: deleted !== "active", deleted }), [deleted]);
  const query = useTenantsInfiniteQuery(filters);

  const [createOpen, setCreateOpen] = useState(false);
  const [editTenant, setEditTenant] = useState<Tenant | null>(null);
  const [selectedTenants, setSelectedTenants] = useState<Record<string, Tenant>>({});
  const [batchAction, setBatchAction] = useState<"delete" | "restore" | null>(null);
  const selectedTenantItems = useMemo(() => Object.values(selectedTenants), [selectedTenants]);
  const deletableTenantItems = selectedTenantItems.filter((tenant) => !tenant.deletedAt);
  const restorableTenantItems = selectedTenantItems.filter((tenant) => tenant.deletedAt);

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

  function toggleTenantSelection(tenant: Tenant, selected: boolean) {
    setSelectedTenants((current) => {
      const next = { ...current };
      if (selected) {
        next[tenant.id] = tenant;
      } else {
        delete next[tenant.id];
      }
      return next;
    });
  }

  async function handleConfirmBatchAction() {
    if (batchAction === "delete") {
      try {
        for (const tenant of deletableTenantItems) {
          await deleteMutation.mutateAsync(tenant.id);
        }
        setSelectedTenants({});
        setBatchAction(null);
      } catch {
        return;
      }
      return;
    }

    if (batchAction === "restore") {
      try {
        for (const tenant of restorableTenantItems) {
          await restoreMutation.mutateAsync(tenant.id);
        }
        setSelectedTenants({});
        setBatchAction(null);
      } catch {
        return;
      }
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeaderActions>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus data-icon="inline-start" />
          Create
        </Button>
      </PageHeaderActions>

      <div className="flex shrink-0 flex-wrap items-center gap-2 p-3">
        <DeletedStatusSelect value={deleted} onChange={setDeleted} />
      </div>

      <BatchActionBar
        selectedCount={selectedTenantItems.length}
        onClear={() => setSelectedTenants({})}
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setBatchAction("restore")}
          disabled={restorableTenantItems.length === 0 || restoreMutation.isPending}
        >
          <RotateCcw data-icon="inline-start" />
          Restore
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={() => setBatchAction("delete")}
          disabled={deletableTenantItems.length === 0 || deleteMutation.isPending}
        >
          <Trash2 data-icon="inline-start" />
          Delete
        </Button>
      </BatchActionBar>

      <InfiniteTableShell
        query={query}
        emptyTitle="No tenants"
        loading={
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead data-table-sticky="start" className={stickyTableStartHeaderClassName} />
                <TableHead>Name</TableHead>
                <TableHead>ID</TableHead>
                <TableHead>Created</TableHead>
                <TableHead data-table-sticky="end" className={stickyTableEndHeaderClassName} />
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableSkeletonRows columns={TENANT_SKELETON_COLUMNS} />
            </TableBody>
          </Table>
        }
      >
        {(items) => (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead data-table-sticky="start" className={stickyTableStartHeaderClassName} />
                <TableHead>Name</TableHead>
                <TableHead>ID</TableHead>
                <TableHead>Created</TableHead>
                <TableHead data-table-sticky="end" className={stickyTableEndHeaderClassName} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((tenant) => (
                <TableRow
                  key={tenant.id}
                  data-state={selectedTenants[tenant.id] ? "selected" : undefined}
                >
                  <TableCell data-table-sticky="start" className={stickyTableStartCellClassName}>
                    <Checkbox
                      aria-label={`Select tenant ${tenant.displayName}`}
                      checked={Boolean(selectedTenants[tenant.id])}
                      onCheckedChange={(checked) => toggleTenantSelection(tenant, checked)}
                    />
                  </TableCell>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      {tenant.displayName}
                      <DeletedBadge deletedAt={tenant.deletedAt} />
                    </span>
                  </TableCell>
                  <TableCell className="max-w-80 break-all font-mono text-sm">
                    {tenant.id}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatTimestamp(tenant.createdAt)}
                  </TableCell>
                  <TableCell data-table-sticky="end" className={stickyTableEndCellClassName}>
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" />}>
                        <MoreHorizontal />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => selectTenant(tenant)}>
                          <Building2 />
                          Select
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
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

      <TenantBatchConfirmDialog
        action={batchAction}
        count={
          batchAction === "restore" ? restorableTenantItems.length : deletableTenantItems.length
        }
        pending={deleteMutation.isPending || restoreMutation.isPending}
        onOpenChange={(open) => {
          if (!open) {
            setBatchAction(null);
          }
        }}
        onConfirm={() => void handleConfirmBatchAction()}
      />
    </div>
  );
}

type TenantBatchConfirmDialogProps = {
  action: "delete" | "restore" | null;
  count: number;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
};

function TenantBatchConfirmDialog({
  action,
  count,
  pending,
  onOpenChange,
  onConfirm,
}: TenantBatchConfirmDialogProps) {
  const deleting = action === "delete";

  return (
    <Dialog open={action !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{deleting ? "Delete tenants" : "Restore tenants"}</DialogTitle>
          <DialogDescription>
            {deleting
              ? `Delete ${count} selected tenant${count === 1 ? "" : "s"}?`
              : `Restore ${count} selected tenant${count === 1 ? "" : "s"}?`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant={deleting ? "destructive" : "default"}
            onClick={onConfirm}
            disabled={pending || count === 0}
          >
            {deleting ? "Delete" : "Restore"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
