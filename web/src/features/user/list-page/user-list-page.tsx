import { Navigate } from "@tanstack/react-router";
import { ChevronRight, Plus, Search } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import { PageHeaderActions } from "#/components/page-header-actions.tsx";
import {
  InfiniteTableShell,
  TableSkeletonRows,
} from "#/components/resources/infinite-table-shell.tsx";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { InputGroup, InputGroupAddon, InputGroupInput } from "#/components/ui/input-group.tsx";
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
} from "#/components/ui/table.tsx";
import { UserDetailsSheet } from "#/features/user/user-details-sheet.tsx";
import { UserFormDialog } from "#/features/user/user-form-dialog.tsx";
import { useUsersInfiniteQuery } from "#/features/user/user.queries.ts";
import { formatTimestamp } from "#/lib/format.ts";
import type { UserDisabledFilterValue } from "#/lib/api/query-keys.ts";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { useTokenVaultStore } from "#/stores/token-vault.ts";

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "disabled", label: "Disabled" },
  { value: "all", label: "All users" },
] satisfies Array<{ value: UserDisabledFilterValue; label: string }>;

const USER_SKELETON_COLUMNS = [
  { skeletonClassName: "h-4 w-44" },
  { skeletonClassName: "h-4 w-28" },
  { skeletonClassName: "h-4 w-20" },
  { skeletonClassName: "h-4 w-36" },
  {
    cellClassName: stickyTableEndCellClassName,
    skeletonClassName: "ml-auto size-7",
    sticky: "end",
  },
] as const;

export function UserListPage() {
  const credentials = useApiCredentials();
  const hydrated = useTokenVaultStore((state) => state.hydrated);
  const bootstrapping = useTokenVaultStore((state) => state.bootstrapping);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<UserDisabledFilterValue>("active");
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const deferredSearch = useDeferredValue(search.trim());
  const filters = useMemo(
    () => ({ query: deferredSearch || undefined, disabled: status }),
    [deferredSearch, status],
  );
  const query = useUsersInfiniteQuery(filters);

  if (hydrated && !bootstrapping && credentials?.authorityType !== "system_admin") {
    return <Navigate to="/" />;
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
        <InputGroup className="w-full sm:w-72">
          <InputGroupInput
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search users"
            aria-label="Search users"
          />
          <InputGroupAddon align="inline-start">
            <Search />
          </InputGroupAddon>
        </InputGroup>
        <Select
          items={STATUS_OPTIONS}
          value={status}
          onValueChange={(value) => {
            if (value === "active" || value === "disabled" || value === "all") {
              setStatus(value);
            }
          }}
        >
          <SelectTrigger className="w-36" aria-label="User status">
            <SelectValue>
              {(value: unknown) =>
                STATUS_OPTIONS.find((option) => option.value === value)?.label ?? "Status"
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {STATUS_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <InfiniteTableShell
        query={query}
        emptyTitle={deferredSearch ? "No matching users" : "No users"}
        loading={
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead data-table-sticky="end" className={stickyTableEndHeaderClassName} />
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableSkeletonRows columns={USER_SKELETON_COLUMNS} />
            </TableBody>
          </Table>
        }
      >
        {(users) => (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead data-table-sticky="end" className={stickyTableEndHeaderClassName} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user) => (
                <TableRow
                  key={user.id}
                  className="cursor-pointer"
                  onClick={() => setSelectedUserId(user.id)}
                >
                  <TableCell>
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate font-medium">{user.displayName}</span>
                      <span className="truncate text-sm text-muted-foreground">
                        {user.email ?? "No email"}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    {user.isSystemAdmin ? (
                      <Badge>System admin</Badge>
                    ) : (
                      <Badge variant="outline">Standard</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {user.disabledAt ? (
                      <Badge variant="outline">Disabled</Badge>
                    ) : (
                      <Badge variant="secondary">Active</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatTimestamp(user.updatedAt)}
                  </TableCell>
                  <TableCell data-table-sticky="end" className={stickyTableEndCellClassName}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Manage ${user.displayName}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedUserId(user.id);
                      }}
                    >
                      <ChevronRight />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </InfiniteTableShell>

      <UserFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSaved={(user) => setSelectedUserId(user.id)}
      />
      <UserDetailsSheet
        userId={selectedUserId}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedUserId(null);
          }
        }}
      />
    </div>
  );
}
