import { Navigate } from "@tanstack/react-router";
import { Building2, MoreHorizontal, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useMemo } from "react";
import { PageHeaderActions } from "#/components/page-header-actions.tsx";
import { TenantFormModal } from "#/features/tenant/form-modal/tenant-form-modal.tsx";
import { BatchActionBar } from "#/components/resources/batch-action-bar.tsx";
import { ConfirmDialog } from "#/components/resources/confirm-dialog.tsx";
import { DeletedStatusSelect } from "#/components/resources/deleted-status-select.tsx";
import {
  InfiniteTableShell,
  TableSkeletonRows,
} from "#/components/resources/infinite-table-shell.tsx";
import { DeletedBadge } from "#/components/resources/status-badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Checkbox } from "#/components/ui/checkbox.tsx";
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
} from "#/features/tenant/tenant.mutations.ts";
import { useTenantsInfiniteQuery } from "#/features/tenant/tenant.queries.ts";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { formatTimestamp } from "#/lib/format.ts";
import type { Tenant } from "#/lib/api/schemas.ts";
import { useTenantFormStore } from "#/features/tenant/form/tenant-form.store.ts";
import { useTenantFormModalStore } from "#/features/tenant/form-modal/tenant-form-modal.store.ts";
import { useTenantListPageStore } from "#/features/tenant/list-page/tenant-list-page.store.ts";
import { selectActiveProfile, useTokenVaultStore } from "#/stores/token-vault.ts";

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

export function TenantListPage() {
  const credentials = useApiCredentials();
  const activeProfile = useTokenVaultStore(selectActiveProfile);
  const setSelectedTenant = useTokenVaultStore((state) => state.setSelectedTenant);
  const hydrated = useTokenVaultStore((state) => state.hydrated);
  const bootstrapping = useTokenVaultStore((state) => state.bootstrapping);

  const deleted = useTenantListPageStore((state) => state.deleted);
  const setDeleted = useTenantListPageStore((state) => state.setDeleted);
  const filters = useMemo(() => ({ includeDeleted: deleted !== "active", deleted }), [deleted]);
  const query = useTenantsInfiniteQuery(filters);

  const initCreateTenant = useTenantFormStore((state) => state.initCreate);
  const initEditTenant = useTenantFormStore((state) => state.initEdit);
  const openTenantModal = useTenantFormModalStore((state) => state.openModal);
  const selectedTenants = useTenantListPageStore((state) => state.selectedTenants);
  const confirmAction = useTenantListPageStore((state) => state.confirmAction);
  const toggleTenantSelection = useTenantListPageStore((state) => state.toggleTenantSelection);
  const clearSelectedTenants = useTenantListPageStore((state) => state.clearSelectedTenants);
  const removeSelectedTenant = useTenantListPageStore((state) => state.removeSelectedTenant);
  const setConfirmAction = useTenantListPageStore((state) => state.setConfirmAction);
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

  async function handleConfirmAction() {
    const action = confirmAction;
    if (!action) {
      return;
    }

    switch (action.kind) {
      case "batch-delete":
        for (const tenant of deletableTenantItems) {
          await deleteMutation.mutateAsync(tenant.id);
        }
        clearSelectedTenants();
        return;
      case "batch-restore":
        for (const tenant of restorableTenantItems) {
          await restoreMutation.mutateAsync(tenant.id);
        }
        clearSelectedTenants();
        return;
      case "delete":
        await deleteMutation.mutateAsync(action.tenant.id);
        removeSelectedTenant(action.tenant.id);
        return;
      default: {
        const _exhaustive: never = action;
        return _exhaustive;
      }
    }
  }

  const confirmDialog =
    confirmAction?.kind === "batch-delete"
      ? {
          title: "Delete tenants",
          description: `Delete ${deletableTenantItems.length} selected tenant${deletableTenantItems.length === 1 ? "" : "s"}?`,
          confirmLabel: "Delete",
          variant: "destructive" as const,
          pending: deleteMutation.isPending,
        }
      : confirmAction?.kind === "batch-restore"
        ? {
            title: "Restore tenants",
            description: `Restore ${restorableTenantItems.length} selected tenant${restorableTenantItems.length === 1 ? "" : "s"}?`,
            confirmLabel: "Restore",
            variant: "default" as const,
            pending: restoreMutation.isPending,
          }
        : confirmAction?.kind === "delete"
          ? {
              title: "Delete tenant",
              description: `Delete tenant ${confirmAction.tenant.displayName}?`,
              confirmLabel: "Delete",
              variant: "destructive" as const,
              pending: deleteMutation.isPending,
            }
          : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeaderActions>
        <Button
          size="sm"
          onClick={() => {
            initCreateTenant();
            openTenantModal();
          }}
        >
          <Plus data-icon="inline-start" />
          Create
        </Button>
      </PageHeaderActions>

      <div className="flex shrink-0 flex-wrap items-center gap-2 p-3">
        <DeletedStatusSelect value={deleted} onChange={setDeleted} />
      </div>

      <BatchActionBar selectedCount={selectedTenantItems.length} onClear={clearSelectedTenants}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setConfirmAction({ kind: "batch-restore" })}
          disabled={restorableTenantItems.length === 0 || restoreMutation.isPending}
        >
          <RotateCcw data-icon="inline-start" />
          Restore
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={() => setConfirmAction({ kind: "batch-delete" })}
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
                  <TableCell
                    data-table-sticky="start"
                    className={`${stickyTableStartCellClassName} cursor-pointer`}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleTenantSelection(tenant, !selectedTenants[tenant.id]);
                    }}
                  >
                    <Checkbox
                      aria-label={`Select tenant ${tenant.displayName}`}
                      checked={Boolean(selectedTenants[tenant.id])}
                      onClick={(event) => event.stopPropagation()}
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
                        <DropdownMenuItem
                          onClick={() => {
                            initEditTenant(tenant.id, tenant.displayName);
                            openTenantModal();
                          }}
                        >
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
                              onClick={() => setConfirmAction({ kind: "delete", tenant })}
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

      <TenantFormModal />

      {confirmDialog ? (
        <ConfirmDialog
          open={confirmAction !== null}
          title={confirmDialog.title}
          description={confirmDialog.description}
          confirmLabel={confirmDialog.confirmLabel}
          variant={confirmDialog.variant}
          pending={confirmDialog.pending}
          onOpenChange={(open) => {
            if (!open) {
              setConfirmAction(null);
            }
          }}
          onConfirm={handleConfirmAction}
        />
      ) : null}
    </div>
  );
}
