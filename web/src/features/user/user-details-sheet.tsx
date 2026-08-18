import { Fragment, useMemo, useState } from "react";
import { KeyRound, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "#/components/resources/confirm-dialog.tsx";
import { MetadataGrid, metadataTimestamp } from "#/components/resources/metadata-grid.tsx";
import { Alert, AlertDescription } from "#/components/ui/alert.tsx";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "#/components/ui/card.tsx";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty.tsx";
import { ScrollArea } from "#/components/ui/scroll-area.tsx";
import { Separator } from "#/components/ui/separator.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "#/components/ui/sheet.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { MembershipDialog } from "#/features/user/membership-dialog.tsx";
import { UserFormDialog } from "#/features/user/user-form-dialog.tsx";
import {
  useDeleteTenantMembershipMutation,
  useDisableUserMutation,
  useRestoreUserMutation,
} from "#/features/user/user.mutations.ts";
import { useUserMembershipsQuery, useUserQuery } from "#/features/user/user.queries.ts";
import { useTenantsInfiniteQuery } from "#/features/tenant/tenant.queries.ts";
import { flattenInfinitePages } from "#/lib/api/pagination.ts";
import type { TenantMembership } from "#/lib/api/schemas.ts";
import { scopeLabel } from "#/lib/scopes.ts";

type MembershipDialogState =
  | { kind: "create" }
  | { kind: "edit"; membership: TenantMembership }
  | null;

type ConfirmAction =
  | { kind: "disable" }
  | { kind: "restore" }
  | { kind: "remove-access"; membership: TenantMembership }
  | null;

type UserDetailsSheetProps = {
  userId: string | null;
  onOpenChange: (open: boolean) => void;
};

export function UserDetailsSheet({ userId, onOpenChange }: UserDetailsSheetProps) {
  const userQuery = useUserQuery(userId);
  const membershipsQuery = useUserMembershipsQuery(userId);
  const tenantsQuery = useTenantsInfiniteQuery({ limit: 100 });
  const disableMutation = useDisableUserMutation();
  const restoreMutation = useRestoreUserMutation();
  const deleteMembershipMutation = useDeleteTenantMembershipMutation();
  const [editOpen, setEditOpen] = useState(false);
  const [membershipDialog, setMembershipDialog] = useState<MembershipDialogState>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);

  const tenantNames = useMemo(
    () =>
      new Map(
        flattenInfinitePages(tenantsQuery.data?.pages).map((tenant) => [
          tenant.id,
          tenant.displayName,
        ]),
      ),
    [tenantsQuery.data?.pages],
  );

  const user = userQuery.data ?? null;
  const memberships = membershipsQuery.data ?? [];
  const selectedMembership = membershipDialog?.kind === "edit" ? membershipDialog.membership : null;
  const selectedTenantLabel = selectedMembership
    ? tenantNames.get(selectedMembership.tenantId)
    : null;
  const lifecyclePending = disableMutation.isPending || restoreMutation.isPending;

  async function handleConfirmAction() {
    if (!user || !confirmAction) {
      return;
    }

    switch (confirmAction.kind) {
      case "disable":
        await disableMutation.mutateAsync(user.id);
        toast.success("User disabled");
        return;
      case "restore":
        await restoreMutation.mutateAsync(user.id);
        toast.success("User restored");
        return;
      case "remove-access":
        await deleteMembershipMutation.mutateAsync({
          userId: user.id,
          tenantId: confirmAction.membership.tenantId,
        });
        toast.success("Tenant access removed");
        return;
      default: {
        const _exhaustive: never = confirmAction;
        return _exhaustive;
      }
    }
  }

  const confirmDialog =
    confirmAction?.kind === "disable"
      ? {
          title: "Disable user",
          description: `Disable ${user?.displayName ?? "this user"}? They will no longer be able to sign in.`,
          confirmLabel: "Disable",
          variant: "destructive" as const,
          pending: disableMutation.isPending,
        }
      : confirmAction?.kind === "restore"
        ? {
            title: "Restore user",
            description: `Restore ${user?.displayName ?? "this user"}?`,
            confirmLabel: "Restore",
            variant: "default" as const,
            pending: restoreMutation.isPending,
          }
        : confirmAction?.kind === "remove-access"
          ? {
              title: "Remove tenant access",
              description: `Remove access to ${tenantNames.get(confirmAction.membership.tenantId) ?? confirmAction.membership.tenantId}?`,
              confirmLabel: "Remove",
              variant: "destructive" as const,
              pending: deleteMembershipMutation.isPending,
            }
          : null;

  return (
    <>
      <Sheet open={userId !== null} onOpenChange={onOpenChange}>
        <SheetContent className="data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
          <SheetHeader className="border-b pr-12">
            <SheetTitle>{user?.displayName ?? "User details"}</SheetTitle>
            <SheetDescription>{user?.email ?? "Account without an email address"}</SheetDescription>
          </SheetHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-4 p-4">
              {userQuery.isLoading ? (
                <>
                  <Skeleton className="h-52 w-full rounded-xl" />
                  <Skeleton className="h-48 w-full rounded-xl" />
                </>
              ) : userQuery.isError || !user ? (
                <Alert variant="destructive">
                  <AlertDescription>Failed to load user</AlertDescription>
                </Alert>
              ) : (
                <>
                  <Card size="sm">
                    <CardHeader>
                      <CardTitle>Account</CardTitle>
                      <CardDescription>Profile and deployment-level access.</CardDescription>
                      <CardAction>
                        <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
                          <Pencil data-icon="inline-start" />
                          Edit
                        </Button>
                      </CardAction>
                    </CardHeader>
                    <CardContent>
                      <MetadataGrid
                        items={[
                          { kind: "identifier", label: "User ID", value: user.id },
                          { kind: "text", label: "Email", value: user.email ?? "—" },
                          {
                            kind: "text",
                            label: "Role",
                            value: user.isSystemAdmin ? (
                              <Badge>System admin</Badge>
                            ) : (
                              <Badge variant="outline">Standard user</Badge>
                            ),
                          },
                          {
                            kind: "text",
                            label: "Status",
                            value: user.disabledAt ? (
                              <Badge variant="outline">Disabled</Badge>
                            ) : (
                              <Badge variant="secondary">Active</Badge>
                            ),
                          },
                          {
                            kind: "text",
                            label: "Created",
                            value: metadataTimestamp(user.createdAt),
                          },
                          {
                            kind: "text",
                            label: "Updated",
                            value: metadataTimestamp(user.updatedAt),
                          },
                        ]}
                      />
                    </CardContent>
                    <CardFooter className="justify-end">
                      {user.disabledAt ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={lifecyclePending}
                          onClick={() => setConfirmAction({ kind: "restore" })}
                        >
                          <RotateCcw data-icon="inline-start" />
                          Restore user
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          disabled={lifecyclePending}
                          onClick={() => setConfirmAction({ kind: "disable" })}
                        >
                          Disable user
                        </Button>
                      )}
                    </CardFooter>
                  </Card>

                  <Card size="sm">
                    <CardHeader>
                      <CardTitle>Tenant access</CardTitle>
                      <CardDescription>
                        Permissions granted within individual tenants.
                      </CardDescription>
                      <CardAction>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={Boolean(user.disabledAt)}
                          title={
                            user.disabledAt ? "Restore the user before granting access" : undefined
                          }
                          onClick={() => setMembershipDialog({ kind: "create" })}
                        >
                          <Plus data-icon="inline-start" />
                          Add
                        </Button>
                      </CardAction>
                    </CardHeader>
                    <CardContent>
                      {membershipsQuery.isLoading ? (
                        <div className="flex flex-col gap-3">
                          <Skeleton className="h-14 w-full" />
                          <Skeleton className="h-14 w-full" />
                        </div>
                      ) : membershipsQuery.isError ? (
                        <Alert variant="destructive">
                          <AlertDescription>Failed to load tenant access</AlertDescription>
                        </Alert>
                      ) : memberships.length === 0 ? (
                        <Empty className="min-h-40 border">
                          <EmptyHeader>
                            <EmptyMedia variant="icon">
                              <KeyRound />
                            </EmptyMedia>
                            <EmptyTitle>No tenant access</EmptyTitle>
                            <EmptyDescription>
                              Add a tenant when this user needs scoped access.
                            </EmptyDescription>
                          </EmptyHeader>
                        </Empty>
                      ) : (
                        <div className="flex flex-col">
                          {memberships.map((membership, index) => (
                            <Fragment key={membership.tenantId}>
                              {index > 0 ? <Separator /> : null}
                              <div className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                                <div className="min-w-0 flex-1">
                                  <div className="truncate font-medium">
                                    {tenantNames.get(membership.tenantId) ?? "Tenant"}
                                  </div>
                                  <div className="truncate font-mono text-xs text-muted-foreground">
                                    {membership.tenantId}
                                  </div>
                                  <div className="mt-2 flex flex-wrap gap-1">
                                    {membership.scopes.map((scope) => (
                                      <Badge key={scope} variant="secondary">
                                        {scopeLabel(scope)}
                                      </Badge>
                                    ))}
                                  </div>
                                </div>
                                <div className="flex shrink-0 gap-1">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label="Edit tenant access"
                                    disabled={Boolean(user.disabledAt)}
                                    title={
                                      user.disabledAt
                                        ? "Restore the user before changing access"
                                        : undefined
                                    }
                                    onClick={() =>
                                      setMembershipDialog({ kind: "edit", membership })
                                    }
                                  >
                                    <Pencil />
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label="Remove tenant access"
                                    onClick={() =>
                                      setConfirmAction({ kind: "remove-access", membership })
                                    }
                                  >
                                    <Trash2 />
                                  </Button>
                                </div>
                              </div>
                            </Fragment>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </>
              )}
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>

      {user ? (
        <>
          <UserFormDialog
            open={editOpen}
            user={user}
            onOpenChange={setEditOpen}
            onSaved={() => setEditOpen(false)}
          />
          <MembershipDialog
            open={membershipDialog !== null}
            userId={user.id}
            membership={selectedMembership}
            tenantLabel={selectedTenantLabel}
            existingTenantIds={memberships.map((membership) => membership.tenantId)}
            onOpenChange={(open) => {
              if (!open) {
                setMembershipDialog(null);
              }
            }}
          />
        </>
      ) : null}

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
    </>
  );
}
