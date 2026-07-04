import { createFileRoute } from "@tanstack/react-router";
import { MoreHorizontal, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { CreateSessionDialog } from "#/components/sessions/create-session-dialog.tsx";
import { PromoteSessionDialog } from "#/components/sessions/promote-session-dialog.tsx";
import { SessionDetailDrawer } from "#/components/sessions/session-detail-drawer.tsx";
import type { TransientCdpCredentials } from "#/components/sessions/connection-panel.tsx";
import { EditTagsDialog } from "#/components/resources/edit-tags-dialog.tsx";
import { IncludeDeletedToggle } from "#/components/resources/include-deleted-toggle.tsx";
import { InfiniteTableShell } from "#/components/resources/infinite-table-shell.tsx";
import { SessionStatusBadge } from "#/components/resources/status-badge.tsx";
import { TagBadges } from "#/components/resources/tag-badges.tsx";
import { TagFilter } from "#/components/resources/tag-filter.tsx";
import { TenantRequiredNotice } from "#/components/resources/tenant-required.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import {
  Select,
  SelectContent,
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
} from "#/components/ui/table.tsx";
import {
  useDeleteSessionMutation,
  useReopenSessionMutation,
  useReplaceSessionTagsMutation,
  useRotateCdpTokenMutation,
} from "#/hooks/mutations/use-session-mutations.ts";
import { useSessionsInfiniteQuery } from "#/hooks/queries/use-sessions-query.ts";
import { hasAllScopes, hasScope, useActiveScopes } from "#/hooks/use-scopes.ts";
import { isTenantScopedQueryReady, useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { formatTimestamp, truncateId } from "#/lib/format.ts";
import type { CreateSessionResponse, Session, SessionStatus } from "#/lib/api/schemas.ts";

export const Route = createFileRoute("/sessions/")({
  component: SessionsPage,
});

const ALL_STATUS = "__all__";

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: ALL_STATUS, label: "All" },
  { value: "running", label: "running" },
  { value: "creating", label: "creating" },
  { value: "deleted", label: "deleted" },
  { value: "failed", label: "failed" },
  { value: "expired", label: "expired" },
];

function SessionsPage() {
  const credentials = useApiCredentials();
  const scopes = useActiveScopes();
  const canWrite = hasScope(scopes, "sessions:write");
  const canPromote = hasAllScopes(scopes, ["sessions:write", "snapshots:write"]);

  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [status, setStatus] = useState<string | undefined>();
  const [tagKey, setTagKey] = useState<string | undefined>();
  const [tagValue, setTagValue] = useState<string | undefined>();

  const filters = useMemo(
    () => ({ includeDeleted, status, tagKey, tagValue }),
    [includeDeleted, status, tagKey, tagValue],
  );

  const query = useSessionsInfiniteQuery(filters);

  const [createOpen, setCreateOpen] = useState(false);
  const [promoteSession, setPromoteSession] = useState<Session | null>(null);
  const [tagsSession, setTagsSession] = useState<Session | null>(null);
  const [detailSession, setDetailSession] = useState<Session | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [transientCdp, setTransientCdp] = useState<TransientCdpCredentials>(null);

  const deleteMutation = useDeleteSessionMutation();
  const reopenMutation = useReopenSessionMutation();
  const rotateMutation = useRotateCdpTokenMutation();
  const replaceTagsMutation = useReplaceSessionTagsMutation();

  const tenantReady = isTenantScopedQueryReady(credentials);

  function openDetail(session: Session) {
    setTransientCdp(null);
    setDetailSession(session);
    setDetailOpen(true);
  }

  function handleDetailOpenChange(open: boolean) {
    setDetailOpen(open);
    if (!open) {
      setTransientCdp(null);
    }
  }

  function handleCreated(result: CreateSessionResponse) {
    setTransientCdp({ cdpUrl: result.cdpUrl, cdpToken: result.cdpToken });
    setDetailSession(result.session);
    setDetailOpen(true);
  }

  async function handleReopen(session: Session) {
    const result = await reopenMutation.mutateAsync(session.id);
    if (result.cdpUrl && result.cdpToken) {
      setTransientCdp({ cdpUrl: result.cdpUrl, cdpToken: result.cdpToken });
      setDetailSession(session);
      setDetailOpen(true);
    }
  }

  async function handleRotate(session: Session) {
    const result = await rotateMutation.mutateAsync(session.id);
    if (result.cdpUrl && result.cdpToken) {
      setTransientCdp({ cdpUrl: result.cdpUrl, cdpToken: result.cdpToken });
      setDetailSession(session);
      setDetailOpen(true);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Sessions</h1>
        {canWrite && tenantReady ? (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus />
            Create
          </Button>
        ) : null}
      </div>

      <TenantRequiredNotice />

      {tenantReady ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Select
              value={status ?? ALL_STATUS}
              onValueChange={(value) =>
                setStatus(value === ALL_STATUS ? undefined : (value ?? undefined))
              }
            >
              <SelectTrigger size="sm" className="w-32">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((option) => (
                  <SelectItem key={option.label} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <IncludeDeletedToggle checked={includeDeleted} onCheckedChange={setIncludeDeleted} />
            <TagFilter
              tagKey={tagKey}
              tagValue={tagValue}
              onApply={(nextKey, nextValue) => {
                setTagKey(nextKey);
                setTagValue(nextValue);
              }}
            />
          </div>

          <InfiniteTableShell query={query} emptyTitle="No sessions">
            {(items) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Channel</TableHead>
                    <TableHead>Snapshot</TableHead>
                    <TableHead>Tags</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((session) => (
                    <TableRow
                      key={session.id}
                      className="cursor-pointer"
                      onClick={() => openDetail(session)}
                    >
                      <TableCell className="font-mono text-xs">
                        {truncateId(session.id, 10)}
                      </TableCell>
                      <TableCell>
                        <SessionStatusBadge status={session.status as SessionStatus} />
                      </TableCell>
                      <TableCell>{session.browserChannel ?? "—"}</TableCell>
                      <TableCell>{session.baseSnapshotName ?? "—"}</TableCell>
                      <TableCell>
                        <TagBadges tags={session.tags} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatTimestamp(session.createdAt)}
                      </TableCell>
                      <TableCell onClick={(event) => event.stopPropagation()}>
                        {canWrite ? (
                          <SessionActionsMenu
                            session={session}
                            canPromote={canPromote}
                            onDelete={() => void deleteMutation.mutateAsync(session.id)}
                            onReopen={() => void handleReopen(session)}
                            onPromote={() => setPromoteSession(session)}
                            onRotate={() => void handleRotate(session)}
                            onEditTags={() => setTagsSession(session)}
                          />
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </InfiniteTableShell>
        </>
      ) : null}

      <CreateSessionDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={handleCreated}
      />

      <PromoteSessionDialog
        session={promoteSession}
        open={promoteSession !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPromoteSession(null);
          }
        }}
      />

      <EditTagsDialog
        open={tagsSession !== null}
        onOpenChange={(open) => {
          if (!open) {
            setTagsSession(null);
          }
        }}
        title="Edit tags"
        initialTags={tagsSession?.tags}
        onSave={async (tags) => {
          if (!tagsSession) {
            return;
          }
          await replaceTagsMutation.mutateAsync({ sessionId: tagsSession.id, tags });
        }}
      />

      <SessionDetailDrawer
        session={detailSession}
        open={detailOpen}
        onOpenChange={handleDetailOpenChange}
        transientCdp={transientCdp}
        onTransientCdpChange={setTransientCdp}
      />
    </div>
  );
}

type SessionActionsMenuProps = {
  session: Session;
  canPromote: boolean;
  onDelete: () => void;
  onReopen: () => void;
  onPromote: () => void;
  onRotate: () => void;
  onEditTags: () => void;
};

function SessionActionsMenu({
  session,
  canPromote,
  onDelete,
  onReopen,
  onPromote,
  onRotate,
  onEditTags,
}: SessionActionsMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-sm" />}
        onClick={(event) => event.stopPropagation()}
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onEditTags}>Edit tags</DropdownMenuItem>
        <DropdownMenuItem onClick={onRotate}>Rotate CDP token</DropdownMenuItem>
        {session.status !== "running" ? (
          <DropdownMenuItem onClick={onReopen}>Reopen</DropdownMenuItem>
        ) : null}
        {canPromote ? <DropdownMenuItem onClick={onPromote}>Promote</DropdownMenuItem> : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={onDelete}>
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
