import { createFileRoute } from "@tanstack/react-router";
import { Ban, MoreHorizontal, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { PageHeaderActions } from "#/components/page-header-actions.tsx";
import { CreateTokenDialog } from "#/components/tokens/create-token-dialog.tsx";
import { BatchActionBar } from "#/components/resources/batch-action-bar.tsx";
import {
  InfiniteTableShell,
  TableSkeletonRows,
} from "#/components/resources/infinite-table-shell.tsx";
import { RevokedBadge } from "#/components/resources/status-badge.tsx";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Checkbox } from "#/components/ui/checkbox.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import { Input } from "#/components/ui/input.tsx";
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
import { useRevokeTokenMutation } from "#/hooks/mutations/use-tenant-token-mutations.ts";
import { useTokensInfiniteQuery } from "#/hooks/queries/use-tokens-query.ts";
import { hasScope, useActiveScopes } from "#/hooks/use-scopes.ts";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { formatTimestamp } from "#/lib/format.ts";
import { adminScopeOptions, scopeLabel, scopePriority, tenantScopeOptions } from "#/lib/scopes.ts";
import type { TokenRevokedFilterValue, TokensFilters } from "#/hooks/queries/keys.ts";
import type { ApiToken } from "#/lib/api/schemas.ts";

export const Route = createFileRoute("/tokens/")({
  component: TokensPage,
});

const ALL_AUTHORITY = "__all__";
const ALL_SCOPES = "__all__";

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

function TokensPage() {
  const credentials = useApiCredentials();
  const scopes = useActiveScopes();
  const isAdmin = credentials?.authorityType === "system_admin";
  const canCreate = isAdmin ? hasScope(scopes, "system:admin") : hasScope(scopes, "tenant:write");

  const [name, setName] = useState("");
  const [revoked, setRevoked] = useState<TokenRevokedFilterValue>("active");
  const [authorityType, setAuthorityType] = useState<string>(ALL_AUTHORITY);
  const [scope, setScope] = useState<string>(ALL_SCOPES);
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
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedTokens, setSelectedTokens] = useState<Record<string, ApiToken>>({});
  const selectedTokenItems = useMemo(() => Object.values(selectedTokens), [selectedTokens]);
  const revokableTokenItems = selectedTokenItems.filter((token) => !token.revokedAt);

  function toggleTokenSelection(token: ApiToken, selected: boolean) {
    setSelectedTokens((current) => {
      const next = { ...current };
      if (selected) {
        next[token.id] = token;
      } else {
        delete next[token.id];
      }
      return next;
    });
  }

  async function handleBatchRevoke() {
    try {
      for (const token of revokableTokenItems) {
        await revokeMutation.mutateAsync(token.id);
      }
      setSelectedTokens({});
    } catch {
      return;
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {canCreate ? (
        <PageHeaderActions>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
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

      <BatchActionBar
        selectedCount={selectedTokenItems.length}
        onClear={() => setSelectedTokens({})}
      >
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={() => void handleBatchRevoke()}
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
                  onRevoke={() => void revokeMutation.mutateAsync(token.id)}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </InfiniteTableShell>

      <CreateTokenDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

type TokenRowProps = {
  token: ApiToken;
  canRevoke: boolean;
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
  onRevoke: () => void;
};

function TokenRow({ token, canRevoke, selected, onSelectedChange, onRevoke }: TokenRowProps) {
  return (
    <TableRow data-state={selected ? "selected" : undefined}>
      <TableCell data-table-sticky="start" className={stickyTableStartCellClassName}>
        <Checkbox
          aria-label={`Select token ${token.name}`}
          checked={selected}
          disabled={!canRevoke || Boolean(token.revokedAt)}
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
      <TableCell data-table-sticky="end" className={stickyTableEndCellClassName}>
        {canRevoke && !token.revokedAt ? (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" />}>
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem variant="destructive" onClick={onRevoke}>
                Revoke
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </TableCell>
    </TableRow>
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
