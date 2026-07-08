import { Ban, MoreHorizontal, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { PageHeaderActions } from "#/components/page-header-actions.tsx";
import { TokenCreateModal } from "#/features/token/create-modal/token-create-modal.tsx";
import { BatchActionBar } from "#/components/resources/batch-action-bar.tsx";
import { ConfirmDialog } from "#/components/resources/confirm-dialog.tsx";
import { MetadataGrid, metadataTimestamp } from "#/components/resources/metadata-grid.tsx";
import {
  InfiniteTableShell,
  TableSkeletonRows,
} from "#/components/resources/infinite-table-shell.tsx";
import { RevokedBadge } from "#/components/resources/status-badge.tsx";
import { Badge } from "#/components/ui/badge.tsx";
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
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import { Input } from "#/components/ui/input.tsx";
import { ScrollArea } from "#/components/ui/scroll-area.tsx";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select.tsx";
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
import { useRevokeTokenMutation } from "#/features/token/token.mutations.ts";
import { useTokensInfiniteQuery } from "#/features/token/token.queries.ts";
import { hasScope, useActiveScopes } from "#/hooks/use-scopes.ts";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { formatTimestamp } from "#/lib/format.ts";
import { adminScopeOptions, scopeLabel, scopePriority, tenantScopeOptions } from "#/lib/scopes.ts";
import type { TokenRevokedFilterValue, TokensFilters } from "#/lib/api/query-keys.ts";
import type { ApiToken } from "#/lib/api/schemas.ts";
import { useTokenCreateFormStore } from "#/features/token/create-form/token-create-form.store.ts";
import { useTokenCreateModalStore } from "#/features/token/create-modal/token-create-modal.store.ts";
import {
  ALL_AUTHORITY,
  ALL_SCOPES,
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
    cellClassName: stickyTableStartCellClassName,
    skeletonClassName: "size-4 rounded-sm",
    sticky: "start",
  },
  { skeletonClassName: "h-4 w-40" },
  { skeletonClassName: "h-4 w-72" },
  { skeletonClassName: "h-4 w-24" },
  { skeletonClassName: "h-5 w-24 rounded-full" },
  { skeletonClassName: "h-4 w-36" },
  { skeletonClassName: "h-4 w-36" },
  {
    cellClassName: stickyTableEndCellClassName,
    skeletonClassName: "ml-auto size-7",
    sticky: "end",
  },
] as const;

export function TokenListPage() {
  const credentials = useApiCredentials();
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
  const scopeFilterOptions = isAdmin ? adminScopeOptions : tenantScopeOptions;
  const filters = useMemo<TokensFilters>(
    () => ({
      name: name.trim() || undefined,
      revoked,
      authorityType:
        isAdmin && (authorityType === "system_admin" || authorityType === "tenant")
          ? authorityType
          : undefined,
      scope: scope === ALL_SCOPES ? undefined : scope,
    }),
    [authorityType, isAdmin, name, revoked, scope],
  );

  const query = useTokensInfiniteQuery(filters);
  const revokeMutation = useRevokeTokenMutation();
  const initCreateTokenForm = useTokenCreateFormStore((state) => state.initForm);
  const openCreateTokenModal = useTokenCreateModalStore((state) => state.openModal);
  const selectedTokens = useTokenListPageStore((state) => state.selectedTokens);
  const confirmAction = useTokenListPageStore((state) => state.confirmAction);
  const toggleTokenSelection = useTokenListPageStore((state) => state.toggleTokenSelection);
  const clearSelectedTokens = useTokenListPageStore((state) => state.clearSelectedTokens);
  const removeSelectedToken = useTokenListPageStore((state) => state.removeSelectedToken);
  const setConfirmAction = useTokenListPageStore((state) => state.setConfirmAction);
  const [viewToken, setViewToken] = useState<ApiToken | null>(null);
  const selectedTokenItems = useMemo(() => Object.values(selectedTokens), [selectedTokens]);
  const revokableTokenItems = selectedTokenItems.filter((token) => !token.revokedAt);

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
          setViewToken(null);
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
    <div className="flex h-full min-h-0 flex-col">
      {canCreate ? (
        <PageHeaderActions>
          <Button
            size="sm"
            onClick={() => {
              initCreateTokenForm(credentials?.selectedTenantId ?? "");
              openCreateTokenModal();
            }}
          >
            <Plus data-icon="inline-start" />
            Create
          </Button>
        </PageHeaderActions>
      ) : null}

      <div className="flex shrink-0 flex-wrap items-center gap-2 p-3">
        <Select
          items={revokedFilterOptions}
          value={revoked}
          onValueChange={(nextValue) => {
            if (nextValue === "active" || nextValue === "revoked" || nextValue === "all") {
              setRevoked(nextValue);
            }
          }}
        >
          <SelectTrigger size="sm" className="w-28">
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
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Token name"
          className="h-7 w-44"
        />
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
            <SelectTrigger size="sm" className="w-40">
              <SelectValue>
                {(selectedValue: unknown) =>
                  authorityFilterOptions.find((option) => option.value === selectedValue)?.label ??
                  "Authority"
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
          <SelectTrigger size="sm" className="w-40">
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

      <BatchActionBar selectedCount={selectedTokenItems.length} onClear={clearSelectedTokens}>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={() => setConfirmAction({ kind: "batch-revoke" })}
          disabled={!canCreate || revokableTokenItems.length === 0 || revokeMutation.isPending}
        >
          <Ban data-icon="inline-start" />
          Revoke
        </Button>
      </BatchActionBar>

      <InfiniteTableShell
        query={query}
        emptyTitle="No tokens"
        loading={
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead data-table-sticky="start" className={stickyTableStartHeaderClassName} />
                <TableHead>Name</TableHead>
                <TableHead>ID</TableHead>
                <TableHead>Authority</TableHead>
                <TableHead>Scopes</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead data-table-sticky="end" className={stickyTableEndHeaderClassName} />
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableSkeletonRows columns={TOKEN_SKELETON_COLUMNS} />
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
                <TableHead>Authority</TableHead>
                <TableHead>Scopes</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead data-table-sticky="end" className={stickyTableEndHeaderClassName} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((token) => (
                <TokenRow
                  key={token.id}
                  token={token}
                  canRevoke={canCreate}
                  selected={Boolean(selectedTokens[token.id])}
                  onSelectedChange={(selected) => toggleTokenSelection(token, selected)}
                  onView={() => setViewToken(token)}
                  onRevoke={() => setConfirmAction({ kind: "revoke", token })}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </InfiniteTableShell>

      <TokenCreateModal />
      <TokenViewModal
        token={viewToken}
        canRevoke={canCreate}
        revokePending={revokeMutation.isPending}
        onOpenChange={(open) => {
          if (!open) {
            setViewToken(null);
          }
        }}
        onRevoke={(token) => setConfirmAction({ kind: "revoke", token })}
      />

      {confirmDialog ? (
        <ConfirmDialog
          open={confirmAction !== null}
          title={confirmDialog.title}
          description={confirmDialog.description}
          confirmLabel={confirmDialog.confirmLabel}
          variant="destructive"
          pending={revokeMutation.isPending}
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

type TokenRowProps = {
  token: ApiToken;
  canRevoke: boolean;
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
  onView: () => void;
  onRevoke: () => void;
};

function TokenRow({
  token,
  canRevoke,
  selected,
  onSelectedChange,
  onView,
  onRevoke,
}: TokenRowProps) {
  return (
    <TableRow
      data-state={selected ? "selected" : undefined}
      className="cursor-pointer"
      onClick={onView}
    >
      <TableCell
        data-table-sticky="start"
        className={`${stickyTableStartCellClassName} ${canRevoke && !token.revokedAt ? "cursor-pointer" : ""}`}
        onClick={(event) => {
          event.stopPropagation();
          if (canRevoke && !token.revokedAt) {
            onSelectedChange(!selected);
          }
        }}
      >
        <Checkbox
          aria-label={`Select token ${token.name}`}
          checked={selected}
          disabled={!canRevoke || Boolean(token.revokedAt)}
          onClick={(event) => event.stopPropagation()}
          onCheckedChange={onSelectedChange}
        />
      </TableCell>
      <TableCell>
        <span className="flex items-center gap-2">
          {token.name}
          <RevokedBadge revokedAt={token.revokedAt} />
        </span>
      </TableCell>
      <TableCell className="max-w-80 break-all font-mono text-sm">{token.id}</TableCell>
      <TableCell>{token.authorityType === "system_admin" ? "System admin" : "Tenant"}</TableCell>
      <TableCell>
        <ScopeSummary scopes={token.scopes} />
      </TableCell>
      <TableCell className="text-muted-foreground">{formatTimestamp(token.createdAt)}</TableCell>
      <TableCell className="text-muted-foreground">{formatTimestamp(token.expiresAt)}</TableCell>
      <TableCell
        data-table-sticky="end"
        className={stickyTableEndCellClassName}
        onClick={(event) => event.stopPropagation()}
      >
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

type TokenViewModalProps = {
  token: ApiToken | null;
  canRevoke: boolean;
  revokePending: boolean;
  onOpenChange: (open: boolean) => void;
  onRevoke: (token: ApiToken) => void;
};

function TokenViewModal({
  token,
  canRevoke,
  revokePending,
  onOpenChange,
  onRevoke,
}: TokenViewModalProps) {
  return (
    <Dialog open={token !== null} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(80vh,640px)] flex-col overflow-hidden sm:max-w-2xl">
        {token ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {token.name}
                <RevokedBadge revokedAt={token.revokedAt} />
              </DialogTitle>
              <DialogDescription className="break-all font-mono">{token.id}</DialogDescription>
            </DialogHeader>
            <ScrollArea className="min-h-0 flex-1">
              <MetadataGrid
                items={[
                  { label: "ID", value: token.id },
                  { label: "Name", value: token.name },
                  {
                    label: "Authority",
                    value: token.authorityType === "system_admin" ? "System admin" : "Tenant",
                  },
                  { label: "Tenant", value: token.tenantId ?? "—" },
                  { label: "Scopes", value: <ScopeList scopes={token.scopes} /> },
                  { label: "Created", value: metadataTimestamp(token.createdAt) },
                  { label: "Expires", value: metadataTimestamp(token.expiresAt) },
                  { label: "Revoked", value: metadataTimestamp(token.revokedAt) },
                ]}
              />
            </ScrollArea>
            <DialogFooter showCloseButton>
              {canRevoke && !token.revokedAt ? (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => onRevoke(token)}
                  disabled={revokePending}
                >
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

function ScopeList({ scopes }: { scopes: string[] }) {
  if (scopes.length === 0) {
    return "—";
  }

  return (
    <div className="flex flex-wrap gap-1">
      {[...scopes].sort().map((scope) => (
        <Badge key={scope} variant="secondary" className="font-normal">
          {scopeLabel(scope)}
        </Badge>
      ))}
    </div>
  );
}

function ScopeSummary({ scopes }: { scopes: string[] }) {
  const primaryScope =
    scopePriority.find((scope) => scopes.includes(scope)) ?? [...scopes].sort()[0] ?? "none";
  const hiddenCount = Math.max(scopes.length - 1, 0);

  return (
    <div className="flex min-w-0 items-center gap-1 whitespace-nowrap">
      <Badge variant="secondary" className="max-w-44 truncate font-normal">
        {scopeLabel(primaryScope)}
      </Badge>
      {hiddenCount > 0 ? (
        <Badge variant="outline" className="font-normal">
          +{hiddenCount}
        </Badge>
      ) : null}
    </div>
  );
}
