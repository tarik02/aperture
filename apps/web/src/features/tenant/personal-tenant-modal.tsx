import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Building2, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "#/components/resources/confirm-dialog.tsx";
import { Button } from "@aperture-browser/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import { useTenantSelection } from "#/hooks/use-tenant-selection.ts";
import { selectAuth, useAuthSessionStore } from "#/stores/auth-session.ts";
import { AuthApi } from "@aperture-browser/api-client";
import { useRunApi } from "@aperture-browser/session-react";

interface PersonalTenantModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Change = "create" | "restore" | "delete";

export function PersonalTenantModal({ open, onOpenChange }: PersonalTenantModalProps) {
  const runApi = useRunApi();
  const queryClient = useQueryClient();
  const auth = useAuthSessionStore(selectAuth);
  const { selectTenant, switching } = useTenantSelection();
  const [pending, setPending] = useState<Change | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const status = auth?.personalTenant ?? null;
  const tenant = status?.tenant ?? null;
  const busy = pending !== null || switching;

  async function change(kind: Change) {
    setPending(kind);
    try {
      const changed = await runApi(
        AuthApi.use((api) =>
          kind === "create"
            ? api.createOwnPersonalTenant()
            : kind === "restore"
              ? api.restoreOwnPersonalTenant()
              : api.deleteOwnPersonalTenant(),
        ),
      );
      void queryClient.invalidateQueries({ queryKey: ["tenants"] });
      // Land in a new or restored tenant; after a delete the server falls back
      // to the default selection.
      await selectTenant(kind === "delete" ? null : changed.id);
      toast.success(
        kind === "create"
          ? "Personal tenant created"
          : kind === "restore"
            ? "Personal tenant restored"
            : "Personal tenant deleted",
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Personal tenant change failed");
      throw error;
    } finally {
      setPending(null);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="aperture:sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Personal tenant</DialogTitle>
            <DialogDescription>
              A tenant of your own with every tenant permission. Nobody else can see or join it,
              administrators included.
            </DialogDescription>
          </DialogHeader>

          {tenant ? (
            <div className="aperture:flex aperture:flex-col aperture:gap-0.5">
              <span className="aperture:truncate aperture:font-medium">{tenant.displayName}</span>
              <span className="aperture:truncate aperture:font-mono aperture:text-xs aperture:text-muted-foreground">
                {tenant.id}
              </span>
            </div>
          ) : status?.restorable ? (
            <p className="aperture:text-sm aperture:text-muted-foreground">
              Your personal tenant is deleted. Restore it to reach its sessions and snapshots again,
              or start a new one.
            </p>
          ) : (
            <p className="aperture:text-sm aperture:text-muted-foreground">
              You have no personal tenant.
            </p>
          )}

          <DialogFooter>
            {tenant ? (
              <>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => setDeleteOpen(true)}
                >
                  <Trash2 data-icon="inline-start" />
                  Delete
                </Button>
                {auth?.selectedTenant?.id === tenant.id ? null : (
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => void selectTenant(tenant.id)}
                  >
                    Switch to it
                  </Button>
                )}
              </>
            ) : (
              <>
                {status?.restorable ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void change("restore").catch(() => undefined)}
                  >
                    <RotateCcw data-icon="inline-start" />
                    {pending === "restore" ? "Restoring..." : "Restore"}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => void change("create").catch(() => undefined)}
                >
                  <Building2 data-icon="inline-start" />
                  {pending === "create"
                    ? "Creating..."
                    : status?.restorable
                      ? "Create new"
                      : "Create"}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteOpen}
        title="Delete personal tenant"
        description={`Delete ${tenant?.displayName ?? "your personal tenant"}? Its sessions and snapshots stay unreachable and its tokens are revoked. You can restore it later.`}
        confirmLabel="Delete"
        pending={pending === "delete"}
        variant="destructive"
        onOpenChange={setDeleteOpen}
        onConfirm={() => change("delete")}
      />
    </>
  );
}
