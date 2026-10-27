import { Navigate } from "@tanstack/react-router";
import { Building2, MoreHorizontal, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useDeferredValue, useMemo } from "react";
import { PageHeaderActions } from "#/components/page-header-actions.tsx";
import { TenantFormModal } from "#/features/tenant/form-modal/tenant-form-modal.tsx";
import { BatchActionBar } from "#/components/resources/batch-action-bar.tsx";
import { ConfirmDialog } from "#/components/resources/confirm-dialog.tsx";
import { DeletedStatusSelect } from "#/components/resources/deleted-status-select.tsx";
import { SearchInput } from "#/components/resources/search-input.tsx";
import {
  InfiniteTableShell,
  TableSkeletonRows,
} from "#/components/resources/infinite-table-shell.tsx";
import { DeletedBadge, PersonalTenantBadge } from "#/components/resources/status-badge.tsx";
import { Button } from "@aperture-browser/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@aperture-browser/ui/components/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@aperture-browser/ui/components/table";
import {
  useDeleteTenantMutation,
  useRestoreTenantMutation,
} from "#/features/tenant/tenant.mutations.ts";
import { useTenantsInfiniteQuery } from "#/features/tenant/tenant.queries.ts";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { formatTimestamp } from "#/lib/format.ts";
import type { Tenant } from "@aperture-browser/api-client";
import { useTenantFormStore } from "#/features/tenant/form/tenant-form.store.ts";
import { useTenantFormModalStore } from "#/features/tenant/form-modal/tenant-form-modal.store.ts";
import { useTenantListPageStore } from "#/features/tenant/list-page/tenant-list-page.store.ts";
import { useAuthSessionStore } from "#/stores/auth-session.ts";
import { useTenantSelection } from "#/hooks/use-tenant-selection.ts";
import { useRowSelection } from "#/hooks/use-row-selection.ts";
import { TableSelectAll, TableSelectRow } from "#/components/resources/table-selection.tsx";

const TENANT_SKELETON_COLUMNS = [
  {
    skeletonClassName: "aperture:size-4 aperture:rounded-sm",
  },
  { skeletonClassName: "aperture:h-4 aperture:w-44" },
  { skeletonClassName: "aperture:h-4 aperture:w-72" },
  { skeletonClassName: "aperture:h-4 aperture:w-36" },
  {
    skeletonClassName: "aperture:ml-auto aperture:size-7",
  },
] as const;

const getTenantId = (tenant: Tenant) => tenant.id;

export function TenantListPage() {
  const { selectTenant: switchTenant } = useTenantSelection();
  const credentials = useApiCredentials();
  const authStatus = useAuthSessionStore((state) => state.status);
  const isTemporaryTenant = useAuthSessionStore((state) => state.isTemporaryTenant);

  const deleted = useTenantListPageStore((state) => state.deleted);
  const setDeleted = useTenantListPageStore((state) => state.setDeleted);
  const search = useTenantListPageStore((state) => state.search);
  const setSearch = useTenantListPageStore((state) => state.setSearch);
  const deferredSearch = useDeferredValue(search.trim());
  const filters = useMemo(
    () => ({ includeDeleted: deleted !== "active", deleted, query: deferredSearch || undefined }),
    [deleted, deferredSearch],
  );
  const query = useTenantsInfiniteQuery(filters);

  const initCreateTenant = useTenantFormStore((state) => state.initCreate);
  const initEditTenant = useTenantFormStore((state) => state.initEdit);
  const openTenantModal = useTenantFormModalStore((state) => state.openModal);
  const confirmAction = useTenantListPageStore((state) => state.confirmAction);
  const setConfirmAction = useTenantListPageStore((state) => state.setConfirmAction);
  const loadedTenants = useMemo(
    () => query.data?.pages.flatMap((page) => page.data) ?? [],
    [query.data?.pages],
  );
  const selection = useRowSelection({
    tableKey: "tenants",
    rows: loadedTenants,
    getId: getTenantId,
  });
  const selectedTenantItems = selection.selectedItems;
  const clearSelectedTenants = selection.clear;
  const deletableTenantItems = selectedTenantItems.filter((tenant) => !tenant.deletedAt);
  // Deleting a personal tenant is final.
  const restorableTenantItems = selectedTenantItems.filter(
    (tenant) => tenant.deletedAt && !tenant.ownerUserId,
  );

  const deleteMutation = useDeleteTenantMutation();
  const restoreMutation = useRestoreTenantMutation();

  if (authStatus !== "loading" && credentials?.authorityType !== "system_admin") {
    return <Navigate to="/" />;
  }

  async function selectTenant(tenant: Tenant) {
    await switchTenant(tenant.id, isTemporaryTenant);
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
        selection.remove(action.tenant.id);
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
    <div className="aperture:flex aperture:h-full aperture:min-h-0 aperture:flex-col">
      <PageHeaderActions>
        <div className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:items-center aperture:gap-2">
          <SearchInput value={search} onChange={setSearch} placeholder="Search tenants" />
          <DeletedStatusSelect value={deleted} onChange={setDeleted} />
        </div>
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
        emptyTitle={deferredSearch ? "No matching tenants" : "No tenants"}
        loading={
          <Table stickyFirstColumn stickyLastColumn>
            <TableHeader>
              <TableRow>
                <TableHead className="aperture:w-8" />
                <TableHead>Name</TableHead>
                <TableHead>ID</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="aperture:w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableSkeletonRows columns={TENANT_SKELETON_COLUMNS} />
            </TableBody>
          </Table>
        }
      >
        {(items) => (
          <Table stickyFirstColumn stickyLastColumn>
            <TableHeader>
              <TableRow>
                <TableSelectAll
                  allSelected={selection.allSelected}
                  someSelected={selection.someSelected}
                  onCheckedChange={selection.toggleAll}
                />
                <TableHead>Name</TableHead>
                <TableHead>ID</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="aperture:w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((tenant) => (
                <TableRow
                  key={tenant.id}
                  data-state={selection.isSelected(tenant.id) ? "selected" : undefined}
                >
                  <TableSelectRow
                    rowId={tenant.id}
                    checked={selection.isSelected(tenant.id)}
                    label={`Select tenant ${tenant.displayName}`}
                    drag={selection.drag}
                    onCheckedChange={(checked, shiftKey) =>
                      selection.toggleOne(tenant.id, checked, shiftKey)
                    }
                  />
                  <TableCell>
                    <span className="aperture:flex aperture:items-center aperture:gap-2">
                      {tenant.displayName}
                      <PersonalTenantBadge ownerUserId={tenant.ownerUserId} />
                      <DeletedBadge deletedAt={tenant.deletedAt} />
                    </span>
                  </TableCell>
                  <TableCell className="aperture:max-w-80 aperture:break-all aperture:font-mono aperture:text-sm">
                    {tenant.id}
                  </TableCell>
                  <TableCell className="aperture:text-muted-foreground">
                    {formatTimestamp(tenant.createdAt)}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" />}>
                        <MoreHorizontal />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => void selectTenant(tenant)}>
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
                          tenant.ownerUserId ? null : (
                            <DropdownMenuItem
                              onClick={() => void restoreMutation.mutateAsync(tenant.id)}
                            >
                              Restore
                            </DropdownMenuItem>
                          )
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
