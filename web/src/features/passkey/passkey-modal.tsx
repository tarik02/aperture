import { useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Fingerprint, Pencil, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "#/components/resources/confirm-dialog.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "#/components/ui/dialog.tsx";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "#/components/ui/empty.tsx";
import { Field, FieldGroup, FieldLabel } from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { apiClient } from "#/lib/api/client.ts";
import { queryKeys } from "#/lib/api/query-keys.ts";
import type { Passkey } from "#/lib/api/schemas.ts";
import { formatTimestamp } from "#/lib/format.ts";

type PendingAction =
  | { kind: "register" }
  | { kind: "rename"; passkeyId: string }
  | { kind: "delete"; passkeyId: string }
  | null;

type PasskeyModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function PasskeyModal({ open, onOpenChange }: PasskeyModalProps) {
  const queryClient = useQueryClient();
  const passkeys = useQuery({
    queryKey: queryKeys.passkeys,
    queryFn: () => apiClient.listPasskeys(),
    enabled: open,
  });
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Passkey | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);

  async function handleRegister(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const passkeyName = name.trim();
    if (!passkeyName) {
      return;
    }

    setPendingAction({ kind: "register" });
    try {
      const options = await apiClient.beginPasskeyRegistration(passkeyName);
      const credential = await startRegistration({ optionsJSON: options.publicKey });
      await apiClient.finishPasskeyRegistration(credential);
      await queryClient.invalidateQueries({ queryKey: queryKeys.passkeys });
      setName("");
      toast.success("Passkey added");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Passkey registration failed");
    } finally {
      setPendingAction(null);
    }
  }

  async function handleRename(passkeyId: string) {
    const passkeyName = editingName.trim();
    if (!passkeyName) {
      return;
    }

    setPendingAction({ kind: "rename", passkeyId });
    try {
      await apiClient.renamePasskey(passkeyId, passkeyName);
      await queryClient.invalidateQueries({ queryKey: queryKeys.passkeys });
      setEditingId(null);
      toast.success("Passkey renamed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Passkey rename failed");
    } finally {
      setPendingAction(null);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) {
      return;
    }

    setPendingAction({ kind: "delete", passkeyId: deleteTarget.id });
    try {
      await apiClient.deletePasskey(deleteTarget.id);
      await queryClient.invalidateQueries({ queryKey: queryKeys.passkeys });
      toast.success("Passkey deleted");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Passkey deletion failed");
      throw error;
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Passkeys</DialogTitle>
          </DialogHeader>

          <form onSubmit={(event) => void handleRegister(event)}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="passkey-name">Name</FieldLabel>
                <div className="flex gap-2">
                  <Input
                    id="passkey-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    disabled={pendingAction !== null}
                  />
                  <Button type="submit" disabled={!name.trim() || pendingAction !== null}>
                    <Plus data-icon="inline-start" />
                    Add
                  </Button>
                </div>
              </Field>
            </FieldGroup>
          </form>

          {passkeys.isPending ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : passkeys.isError ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Could not load passkeys</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : passkeys.data.passkeys.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Fingerprint />
                </EmptyMedia>
                <EmptyTitle>No passkeys</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="flex flex-col divide-y">
              {passkeys.data.passkeys.map((passkey) => {
                const renaming =
                  pendingAction?.kind === "rename" && pendingAction.passkeyId === passkey.id;
                return (
                  <div key={passkey.id} className="flex min-h-14 items-center gap-2 py-2">
                    {editingId === passkey.id ? (
                      <Input
                        className="min-w-0 flex-1"
                        aria-label="Passkey name"
                        value={editingName}
                        onChange={(event) => setEditingName(event.target.value)}
                        disabled={renaming}
                      />
                    ) : (
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{passkey.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {passkey.lastUsedAt
                            ? `Last used ${formatTimestamp(passkey.lastUsedAt)}`
                            : `Added ${formatTimestamp(passkey.createdAt)}`}
                        </div>
                      </div>
                    )}

                    {editingId === passkey.id ? (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          disabled={!editingName.trim() || renaming}
                          onClick={() => void handleRename(passkey.id)}
                        >
                          <Check />
                          <span className="sr-only">Save name</span>
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          disabled={renaming}
                          onClick={() => setEditingId(null)}
                        >
                          <X />
                          <span className="sr-only">Cancel rename</span>
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          disabled={pendingAction !== null}
                          onClick={() => {
                            setEditingId(passkey.id);
                            setEditingName(passkey.name);
                          }}
                        >
                          <Pencil />
                          <span className="sr-only">Rename {passkey.name}</span>
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          disabled={pendingAction !== null}
                          onClick={() => {
                            setDeleteTarget(passkey);
                            setDeleteOpen(true);
                          }}
                        >
                          <Trash2 />
                          <span className="sr-only">Delete {passkey.name}</span>
                        </Button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {deleteTarget ? (
        <ConfirmDialog
          open={deleteOpen}
          title="Delete passkey"
          description={`Delete ${deleteTarget.name}?`}
          confirmLabel="Delete"
          pending={pendingAction?.kind === "delete" && pendingAction.passkeyId === deleteTarget.id}
          variant="destructive"
          onOpenChange={setDeleteOpen}
          onConfirm={handleDelete}
        />
      ) : null}
    </>
  );
}
