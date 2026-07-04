import { createFileRoute } from "@tanstack/react-router";
import { MoreHorizontal, Plus } from "lucide-react";
import { useState } from "react";
import { CreateTokenDialog } from "#/components/tokens/create-token-dialog.tsx";
import { InfiniteTableShell } from "#/components/resources/infinite-table-shell.tsx";
import { RevokedBadge } from "#/components/resources/status-badge.tsx";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import { useRevokeTokenMutation } from "#/hooks/mutations/use-tenant-token-mutations.ts";
import { useTokensInfiniteQuery } from "#/hooks/queries/use-tokens-query.ts";
import { hasScope, useActiveScopes } from "#/hooks/use-scopes.ts";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { formatTimestamp, truncateId } from "#/lib/format.ts";
import type { ApiToken } from "#/lib/api/schemas.ts";

export const Route = createFileRoute("/tokens/")({
  component: TokensPage,
});

function TokensPage() {
  const credentials = useApiCredentials();
  const scopes = useActiveScopes();
  const isAdmin = credentials?.authorityType === "system_admin";
  const canCreate = isAdmin ? hasScope(scopes, "system:admin") : hasScope(scopes, "tenant:write");

  const query = useTokensInfiniteQuery();
  const revokeMutation = useRevokeTokenMutation();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Tokens</h1>
        {canCreate ? (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus />
            Create
          </Button>
        ) : null}
      </div>

      <InfiniteTableShell query={query} emptyTitle="No tokens">
        {(items) => (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>ID</TableHead>
                <TableHead>Authority</TableHead>
                <TableHead>Scopes</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((token) => (
                <TokenRow
                  key={token.id}
                  token={token}
                  canRevoke={canCreate}
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
  onRevoke: () => void;
};

function TokenRow({ token, canRevoke, onRevoke }: TokenRowProps) {
  return (
    <TableRow>
      <TableCell>
        <span className="flex items-center gap-2">
          {token.name}
          <RevokedBadge revokedAt={token.revokedAt} />
        </span>
      </TableCell>
      <TableCell className="font-mono text-xs">{truncateId(token.id, 10)}</TableCell>
      <TableCell>{token.authorityType}</TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {token.scopes.map((scope) => (
            <Badge key={scope} variant="secondary" className="font-normal">
              {scope}
            </Badge>
          ))}
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground">{formatTimestamp(token.createdAt)}</TableCell>
      <TableCell className="text-muted-foreground">{formatTimestamp(token.expiresAt)}</TableCell>
      <TableCell>
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
