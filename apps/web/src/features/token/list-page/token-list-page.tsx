import { Ban, MoreHorizontal, Plus } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import { PageHeaderActions } from "#/components/page-header-actions.tsx";
import { TokenCreateModal } from "#/features/token/create-modal/token-create-modal.tsx";
import { BatchActionBar } from "#/components/resources/batch-action-bar.tsx";
import { ConfirmDialog } from "#/components/resources/confirm-dialog.tsx";
import { DetailList, DetailRow, DetailSection } from "#/components/details/detail-list.tsx";
import { ReferenceValue, reference, relativeTime } from "#/components/details/detail-values.tsx";
import { IdChip } from "#/components/details/id-chip.tsx";
import {
  InfiniteTableShell,
  TableSkeletonRows,
} from "#/components/resources/infinite-table-shell.tsx";
import { RevokedBadge } from "#/components/resources/status-badge.tsx";
import { Badge } from "@aperture-browser/ui/components/badge";
import { Button } from "@aperture-browser/ui/components/button";
import { TableSelectAll, TableSelectRow } from "#/components/resources/table-selection.tsx";
import { useRowSelection, type RowSelectionDragControls } from "#/hooks/use-row-selection.ts";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@aperture-browser/ui/components/dropdown-menu";
import { SearchInput } from "#/components/resources/search-input.tsx";
import { ScrollArea } from "@aperture-browser/ui/components/scroll-area";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@aperture-browser/ui/components/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@aperture-browser/ui/components/table";
import { useRevokeTokenMutation } from "#/features/token/token.mutations.ts";
import { useTokensInfiniteQuery } from "#/features/token/token.queries.ts";
import { hasScope, useActiveScopes } from "#/hooks/use-scopes.ts";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { formatTimestamp } from "#/lib/format.ts";
import { adminScopeOptions, scopeLabel, scopePriority, tenantScopeOptions } from "#/lib/scopes.ts";
import type { TokenRevokedFilterValue, TokensFilters } from "#/lib/api/query-keys.ts";
import type { ApiToken, ResourceGrant } from "@aperture-browser/api-client";
import { selectPrincipal, useAuthSessionStore } from "#/stores/auth-session.ts";
import { useTokenCreateFormStore } from "#/features/token/create-form/token-create-form.store.ts";
import { useTokenCreateModalStore } from "#/features/token/create-modal/token-create-modal.store.ts";
import {
  ALL_AUTHORITY,
  ALL_SCOPES,
  type TokenConfirmAction,
  useTokenListPageStore,
} from "#/features/token/list-page/token-list-page.store.ts";

const revokedFilterOptions: Array<{ value: TokenRevokedFilterValue; label: string }> = [
  { value: "active", label: "Active" },
  { value: "revoked", label: "Revoked" },
  { value: "all", label: "All" },
];

const authorityFilterOptions = [
  { value: ALL_AUTHORITY, label: "All authorities" },
  { value: "tenant", label: "Tenant" },
  { value: "system_admin", label: "System admin" },
];

const TOKEN_SKELETON_COLUMNS = [
  {
    skeletonClassName: "aperture:size-4 aperture:rounded-sm",
  },
  { skeletonClassName: "aperture:h-4 aperture:w-40" },
  { skeletonClassName: "aperture:h-4 aperture:w-72" },
  { skeletonClassName: "aperture:h-4 aperture:w-24" },
  { skeletonClassName: "aperture:h-5 aperture:w-24 aperture:rounded-full" },
  { skeletonClassName: "aperture:h-5 aperture:w-24 aperture:rounded-full" },
  { skeletonClassName: "aperture:h-4 aperture:w-36" },
  { skeletonClassName: "aperture:h-4 aperture:w-36" },
  {
    skeletonClassName: "aperture:ml-auto aperture:size-7",
  },
] as const;

const getTokenId = (token: ApiToken) => token.id;

export function TokenListPage() {
  const credentials = useApiCredentials();
  const principal = useAuthSessionStore(selectPrincipal);
  const scopes = useActiveScopes();
  const isAdmin = credentials?.authorityType === "system_admin";
  const canCreate = isAdmin ? hasScope(scopes, "system:admin") : hasScope(scopes, "tenant:write");

  const name = useTokenListPageStore((state) => state.name);
  const revoked = useTokenListPageStore((state) => state.revoked);
  const authorityType = useTokenListPageStore((state) => state.authorityType);
  const scope = useTokenListPageStore((state) => state.scope);
  const setName = useTokenListPageStore((state) => state.setName);
  const setRevoked = useTokenListPageStore((state) => state.setRevoked);
  const setAuthorityType = useTokenListPageStore((state) => state.setAuthorityType);
  const setScope = useTokenListPageStore((state) => state.setScope);
  const deferredName = useDeferredValue(name.trim());
  const scopeFilterOptions = isAdmin ? adminScopeOptions : tenantScopeOptions;
  const filters = useMemo<TokensFilters>(
    () => ({
      name: deferredName || undefined,
      revoked,
      authorityType:
        isAdmin && (authorityType === "system_admin" || authorityType === "tenant")
          ? authorityType
          : undefined,
      scope: scope === ALL_SCOPES ? undefined : scope,
    }),
    [authorityType, isAdmin, deferredName, revoked, scope],
  );

  const query = useTokensInfiniteQuery(filters);
  const revokeMutation = useRevokeTokenMutation();
  const initCreateTokenForm = useTokenCreateFormStore((state) => state.initForm);
  const openCreateTokenModal = useTokenCreateModalStore((state) => state.openModal);
  const confirmAction = useTokenListPageStore((state) => state.confirmAction);
  const setConfirmAction = useTokenListPageStore((state) => state.setConfirmAction);
  const [viewToken, setViewToken] = useState<ApiToken | null>(null);
  const [viewTokenOpen, setViewTokenOpen] = useState(false);
  const [confirmActionOpen, setConfirmActionOpen] = useState(false);
  // Only tokens that can still be revoked are selectable.
  const selectableTokens = useMemo(
    () =>
      canCreate
        ? (query.data?.pages.flatMap((page) => page.data) ?? []).filter((token) => !token.revokedAt)
        : [],
    [canCreate, query.data?.pages],
  );
  const selection = useRowSelection({
    tableKey: "tokens",
    rows: selectableTokens,
    getId: getTokenId,
  });
  const selectedTokenItems = selection.selectedItems;
  const clearSelectedTokens = selection.clear;
  const removeSelectedToken = selection.remove;
  const revokableTokenItems = selectedTokenItems.filter((token) => !token.revokedAt);

  function openViewToken(token: ApiToken) {
    setViewToken(token);
    setViewTokenOpen(true);
  }

  function openConfirmAction(action: TokenConfirmAction) {
    setConfirmAction(action);
    setConfirmActionOpen(true);
  }

  async function handleBatchRevoke() {
    try {
      for (const token of revokableTokenItems) {
        await revokeMutation.mutateAsync(token.id);
      }
      clearSelectedTokens();
    } catch {
      return;
    }
  }

  async function handleConfirmAction() {
    const action = confirmAction;
    if (!action) {
      return;
    }

    switch (action.kind) {
      case "batch-revoke":
        await handleBatchRevoke();
        return;
      case "revoke":
        await revokeMutation.mutateAsync(action.token.id);
        removeSelectedToken(action.token.id);
        if (viewToken?.id === action.token.id) {
          setViewTokenOpen(false);
        }
        return;
      default: {
        const _exhaustive: never = action;
        return _exhaustive;
      }
    }
  }

  const confirmDialog =
    confirmAction?.kind === "batch-revoke"
      ? {
          title: "Revoke tokens",
          description: `Revoke ${revokableTokenItems.length} selected token${revokableTokenItems.length === 1 ? "" : "s"}?`,
          confirmLabel: "Revoke",
        }
      : confirmAction?.kind === "revoke"
        ? {
            title: "Revoke token",
            description: `Revoke token ${confirmAction.token.name}?`,
            confirmLabel: "Revoke",
          }
        : null;

  return (
    <div className="aperture:flex aperture:h-full aperture:min-h-0 aperture:flex-col">
      <PageHeaderActions>
        <div className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:items-center aperture:gap-2">
          <SearchInput value={name} onChange={setName} placeholder="Search tokens" />
          <Select
            items={revokedFilterOptions}
            value={revoked}
            onValueChange={(nextValue) => {
              if (nextValue === "active" || nextValue === "revoked" || nextValue === "all") {
                setRevoked(nextValue);
              }
            }}
          >
            <SelectTrigger size="sm" className="aperture:w-28">
              <SelectValue>
                {(selectedValue: unknown) =>
                  revokedFilterOptions.find((option) => option.value === selectedValue)?.label ??
                  "Status"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent align="start">
              <SelectGroup>
                {revokedFilterOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {isAdmin ? (
            <Select
              items={authorityFilterOptions}
              value={authorityType}
              onValueChange={(nextValue) => {
                if (
                  nextValue === ALL_AUTHORITY ||
                  nextValue === "system_admin" ||
                  nextValue === "tenant"
                ) {
                  setAuthorityType(nextValue);
                }
              }}
            >
              <SelectTrigger size="sm" className="aperture:w-40">
                <SelectValue>
                  {(selectedValue: unknown) =>
                    authorityFilterOptions.find((option) => option.value === selectedValue)
                      ?.label ?? "Authority"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent align="start">
                <SelectGroup>
                  {authorityFilterOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          ) : null}
          <Select
            items={scopeFilterOptions}
            value={scope}
            onValueChange={(nextValue) => {
              if (typeof nextValue === "string") {
                setScope(nextValue);
              }
            }}
          >
            <SelectTrigger size="sm" className="aperture:w-40">
              <SelectValue>
                {(selectedValue: unknown) =>
                  selectedValue === ALL_SCOPES
                    ? "All scopes"
                    : (scopeFilterOptions.find((option) => option.value === selectedValue)?.label ??
                      "All scopes")
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent align="start">
              <SelectGroup>
                <SelectItem value={ALL_SCOPES}>All scopes</SelectItem>
                {scopeFilterOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </PageHeaderActions>
      {canCreate ? (
        <PageHeaderActions>
          <Button
            size="sm"
            onClick={() => {
              initCreateTokenForm(
                credentials?.selectedTenantId ?? "",
                principal?.resourceMode ?? "all",
              );
              openCreateTokenModal();
            }}
          >
            <Plus data-icon="inline-start" />
            Create
          </Button>
        </PageHeaderActions>
      ) : null}

      <BatchActionBar selectedCount={selectedTokenItems.length} onClear={clearSelectedTokens}>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={() => openConfirmAction({ kind: "batch-revoke" })}
          disabled={!canCreate || revokableTokenItems.length === 0 || revokeMutation.isPending}
        >
          <Ban data-icon="inline-start" />
          Revoke
        </Button>
      </BatchActionBar>

      <InfiniteTableShell
        query={query}
        emptyTitle={deferredName ? "No matching tokens" : "No tokens"}
        loading={
          <Table stickyFirstColumn stickyLastColumn>
            <TableHeader>
              <TableRow>
                <TableHead className="aperture:w-8" />
                <TableHead>Name</TableHead>
                <TableHead>ID</TableHead>
                <TableHead>Authority</TableHead>
                <TableHead>Scopes</TableHead>
                <TableHead>Resources</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="aperture:w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableSkeletonRows columns={TOKEN_SKELETON_COLUMNS} />
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
                  disabled={selectableTokens.length === 0}
                  onCheckedChange={selection.toggleAll}
                />
                <TableHead>Name</TableHead>
                <TableHead>ID</TableHead>
                <TableHead>Authority</TableHead>
                <TableHead>Scopes</TableHead>
                <TableHead>Resources</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="aperture:w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((token) => (
                <TokenRow
                  key={token.id}
                  token={token}
                  canRevoke={canCreate}
                  selected={selection.isSelected(token.id)}
                  selectionDrag={selection.drag}
                  onSelectedChange={(selected, shiftKey) =>
                    selection.toggleOne(token.id, selected, shiftKey)
                  }
                  onView={() => openViewToken(token)}
                  onRevoke={() => openConfirmAction({ kind: "revoke", token })}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </InfiniteTableShell>

      <TokenCreateModal />
      <TokenViewModal
        token={viewToken}
        open={viewTokenOpen}
        canRevoke={canCreate}
        revokePending={revokeMutation.isPending}
        onOpenChange={setViewTokenOpen}
        onRevoke={(token) => openConfirmAction({ kind: "revoke", token })}
      />

      {confirmDialog ? (
        <ConfirmDialog
          open={confirmActionOpen}
          title={confirmDialog.title}
          description={confirmDialog.description}
          confirmLabel={confirmDialog.confirmLabel}
          variant="destructive"
          pending={revokeMutation.isPending}
          onOpenChange={setConfirmActionOpen}
          onConfirm={handleConfirmAction}
        />
      ) : null}
    </div>
  );
}

interface TokenRowProps {
  token: ApiToken;
  canRevoke: boolean;
  selected: boolean;
  selectionDrag: RowSelectionDragControls;
  onSelectedChange: (selected: boolean, shiftKey: boolean) => void;
  onView: () => void;
  onRevoke: () => void;
}

function TokenRow({
  token,
  canRevoke,
  selected,
  selectionDrag,
  onSelectedChange,
  onView,
  onRevoke,
}: TokenRowProps) {
  return (
    <TableRow
      data-state={selected ? "selected" : undefined}
      className="aperture:cursor-pointer"
      onClick={onView}
    >
      <TableSelectRow
        rowId={token.id}
        checked={selected}
        label={`Select token ${token.name}`}
        disabled={!canRevoke || Boolean(token.revokedAt)}
        drag={selectionDrag}
        onCheckedChange={onSelectedChange}
      />
      <TableCell>
        <span className="aperture:flex aperture:items-center aperture:gap-2">
          {token.name}
          <RevokedBadge revokedAt={token.revokedAt} />
        </span>
      </TableCell>
      <TableCell className="aperture:max-w-80 aperture:break-all aperture:font-mono aperture:text-sm">
        {token.id}
      </TableCell>
      <TableCell>{token.authorityType === "system_admin" ? "System admin" : "Tenant"}</TableCell>
      <TableCell>
        <ScopeSummary scopes={token.scopes} />
      </TableCell>
      <TableCell>
        <ResourceSummary token={token} />
      </TableCell>
      <TableCell className="aperture:text-muted-foreground">
        {formatTimestamp(token.createdAt)}
      </TableCell>
      <TableCell className="aperture:text-muted-foreground">
        {formatTimestamp(token.expiresAt)}
      </TableCell>
      <TableCell onClick={(event) => event.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" />}>
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onView}>View</DropdownMenuItem>
            {canRevoke && !token.revokedAt ? (
              <DropdownMenuItem variant="destructive" onClick={onRevoke}>
                Revoke
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}

interface TokenViewModalProps {
  token: ApiToken | null;
  open: boolean;
  canRevoke: boolean;
  revokePending: boolean;
  onOpenChange: (open: boolean) => void;
  onRevoke: (token: ApiToken) => void;
}

function TokenViewModal({
  token,
  open,
  canRevoke,
  revokePending,
  onOpenChange,
  onRevoke,
}: TokenViewModalProps) {
  const createdBy = token?.createdBy;
  return (
    <Dialog open={open && token !== null} onOpenChange={onOpenChange}>
      <DialogContent className="aperture:flex aperture:max-h-[min(80svh,640px)] aperture:flex-col aperture:gap-3 aperture:overflow-hidden aperture:sm:max-w-lg">
        {token ? (
          <>
            <DialogHeader className="aperture:gap-1.5 aperture:pr-8 aperture:pb-0">
              <DialogTitle className="aperture:flex aperture:min-w-0 aperture:flex-wrap aperture:items-center aperture:gap-2">
                <span className="aperture:min-w-0 aperture:truncate">{token.name}</span>
                <RevokedBadge revokedAt={token.revokedAt} />
                {token.authorityType === "system_admin" ? (
                  <Badge variant="secondary">system admin</Badge>
                ) : null}
              </DialogTitle>
              <IdChip value={token.id} label="token ID" />
            </DialogHeader>
            <ScrollArea
              className="aperture:min-h-0 aperture:flex-1"
              viewportClassName="aperture:data-[has-overflow-y]:pr-3"
            >
              <DetailList className="aperture:py-1">
                <DetailSection title="Access">
                  <DetailRow label="Authority">
                    {token.authorityType === "system_admin" ? "System admin" : "Tenant"}
                  </DetailRow>
                  <DetailRow label="Tenant">{reference(token.tenant)}</DetailRow>
                  <DetailRow label="Scopes">
                    <ScopeList scopes={token.scopes} />
                  </DetailRow>
                  <DetailRow label="Resources">
                    {token.resourceMode === "all" ? (
                      "All resources"
                    ) : (
                      <ResourceGrantList grants={token.resourceGrants} />
                    )}
                  </DetailRow>
                </DetailSection>
                <DetailSection title="Lifecycle">
                  <DetailRow label="Created">{relativeTime(token.createdAt)}</DetailRow>
                  <DetailRow label="Created by">
                    {createdBy?.type !== "system" && createdBy?.id
                      ? reference(
                          { id: createdBy.id, name: createdBy.name },
                          createdBy.type === "user" ? "User" : "API token",
                        )
                      : "System"}
                  </DetailRow>
                  <DetailRow label="Parent token">{reference(token.parentToken)}</DetailRow>
                  <DetailRow label="Expires">{relativeTime(token.expiresAt) ?? "Never"}</DetailRow>
                  <DetailRow label="Revoked">{relativeTime(token.revokedAt)}</DetailRow>
                </DetailSection>
              </DetailList>
            </ScrollArea>
            <DialogFooter showCloseButton className="aperture:mt-1">
              {canRevoke && !token.revokedAt ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="aperture:text-destructive aperture:hover:bg-destructive/10 aperture:hover:text-destructive"
                  onClick={() => onRevoke(token)}
                  disabled={revokePending}
                >
                  <Ban data-icon="inline-start" />
                  Revoke
                </Button>
              ) : null}
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ScopeList({ scopes }: { scopes: readonly string[] }) {
  if (scopes.length === 0) {
    return "None";
  }

  return (
    <div className="aperture:flex aperture:flex-wrap aperture:gap-1">
      {[...scopes].sort().map((scope) => (
        <Badge key={scope} variant="secondary" className="aperture:font-normal">
          {scopeLabel(scope)}
        </Badge>
      ))}
    </div>
  );
}

function ScopeSummary({ scopes }: { scopes: readonly string[] }) {
  const primaryScope =
    scopePriority.find((scope) => scopes.includes(scope)) ?? [...scopes].sort()[0] ?? "none";
  const hiddenCount = Math.max(scopes.length - 1, 0);

  return (
    <div className="aperture:flex aperture:min-w-0 aperture:items-center aperture:gap-1 aperture:whitespace-nowrap">
      <Badge
        variant="secondary"
        className="aperture:max-w-44 aperture:truncate aperture:font-normal"
      >
        {scopeLabel(primaryScope)}
      </Badge>
      {hiddenCount > 0 ? (
        <Badge variant="outline" className="aperture:font-normal">
          +{hiddenCount}
        </Badge>
      ) : null}
    </div>
  );
}

function ResourceSummary({ token }: { token: ApiToken }) {
  if (token.resourceMode === "all") {
    return (
      <Badge variant="secondary" className="aperture:font-normal">
        All resources
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className="aperture:font-normal">
      {token.resourceGrants.length} grant{token.resourceGrants.length === 1 ? "" : "s"}
    </Badge>
  );
}

function ResourceGrantList({ grants }: { grants: readonly ResourceGrant[] }) {
  if (grants.length === 0) {
    return "No resources";
  }

  return (
    <ul className="aperture:flex aperture:flex-col aperture:gap-1">
      {grants.map((grant) => (
        <li
          key={`${grant.resourceType}:${grant.resourceId}`}
          className="aperture:flex aperture:min-w-0 aperture:items-center aperture:gap-2"
        >
          <Badge
            variant="outline"
            className="aperture:shrink-0 aperture:font-normal aperture:capitalize"
          >
            {grant.resourceType}
          </Badge>
          <span className="aperture:min-w-0">
            <ReferenceValue id={grant.resourceId} name={grant.label} />
          </span>
        </li>
      ))}
    </ul>
  );
}
