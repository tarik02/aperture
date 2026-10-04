import { Navigate } from "@tanstack/react-router";
import { ChevronRight, Plus } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import { PageHeaderActions } from "#/components/page-header-actions.tsx";
import {
  InfiniteTableShell,
  TableSkeletonRows,
} from "#/components/resources/infinite-table-shell.tsx";
import { Badge } from "@aperture-browser/ui/components/badge";
import { Button } from "@aperture-browser/ui/components/button";
import { SearchInput } from "#/components/resources/search-input.tsx";
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
import { UserDetailsSheet } from "#/features/user/user-details-sheet.tsx";
import { UserFormDialog } from "#/features/user/user-form-dialog.tsx";
import { useUsersInfiniteQuery } from "#/features/user/user.queries.ts";
import { formatTimestamp } from "#/lib/format.ts";
import type { UserDisabledFilterValue } from "#/lib/api/query-keys.ts";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { useAuthSessionStore } from "#/stores/auth-session.ts";

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "disabled", label: "Disabled" },
  { value: "all", label: "All users" },
] satisfies Array<{ value: UserDisabledFilterValue; label: string }>;

const USER_SKELETON_COLUMNS = [
  { skeletonClassName: "aperture:h-4 aperture:w-44" },
  { skeletonClassName: "aperture:h-4 aperture:w-28" },
  { skeletonClassName: "aperture:h-4 aperture:w-20" },
  { skeletonClassName: "aperture:h-4 aperture:w-36" },
  {
    skeletonClassName: "aperture:ml-auto aperture:size-7",
  },
] as const;

export function UserListPage() {
  const credentials = useApiCredentials();
  const authStatus = useAuthSessionStore((state) => state.status);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<UserDisabledFilterValue>("active");
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [userSheetOpen, setUserSheetOpen] = useState(false);
  const deferredSearch = useDeferredValue(search.trim());
  const filters = useMemo(
    () => ({ query: deferredSearch || undefined, disabled: status }),
    [deferredSearch, status],
  );
  const query = useUsersInfiniteQuery(filters);

  if (authStatus !== "loading" && credentials?.authorityType !== "system_admin") {
    return <Navigate to="/" />;
  }

  return (
    <div className="aperture:flex aperture:h-full aperture:min-h-0 aperture:flex-col">
      <PageHeaderActions>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus data-icon="inline-start" />
          Create
        </Button>
      </PageHeaderActions>

      <div className="aperture:flex aperture:shrink-0 aperture:flex-wrap aperture:items-center aperture:gap-2 aperture:p-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Search users" />
        <Select
          items={STATUS_OPTIONS}
          value={status}
          onValueChange={(value) => {
            if (value === "active" || value === "disabled" || value === "all") {
              setStatus(value);
            }
          }}
        >
          <SelectTrigger size="sm" className="aperture:w-36" aria-label="User status">
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
          <Table stickyLastColumn>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="aperture:w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableSkeletonRows columns={USER_SKELETON_COLUMNS} />
            </TableBody>
          </Table>
        }
      >
        {(users) => (
          <Table stickyLastColumn>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="aperture:w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user) => (
                <TableRow
                  key={user.id}
                  className="aperture:cursor-pointer"
                  onClick={() => {
                    setSelectedUserId(user.id);
                    setUserSheetOpen(true);
                  }}
                >
                  <TableCell>
                    <div className="aperture:flex aperture:min-w-0 aperture:flex-col aperture:gap-0.5">
                      <span className="aperture:truncate aperture:font-medium">
                        {user.displayName}
                      </span>
                      <span className="aperture:truncate aperture:text-sm aperture:text-muted-foreground">
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
                  <TableCell className="aperture:text-muted-foreground">
                    {formatTimestamp(user.updatedAt)}
                  </TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Manage ${user.displayName}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedUserId(user.id);
                        setUserSheetOpen(true);
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
        onSaved={(user) => {
          setSelectedUserId(user.id);
          setUserSheetOpen(true);
        }}
      />
      <UserDetailsSheet
        open={userSheetOpen}
        userId={selectedUserId}
        onOpenChange={setUserSheetOpen}
        onOpenChangeComplete={(open) => {
          if (!open) {
            setSelectedUserId(null);
          }
        }}
      />
    </div>
  );
}
