import { useEffect } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import { Field, FieldError, FieldGroup, FieldLabel } from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import { useTokenBootstrap } from "#/hooks/use-token-bootstrap.ts";
import { parseTokenId } from "#/lib/token-id.ts";
import { useFormDraftStore } from "#/stores/form-drafts.ts";
import { useTokenVaultStore } from "#/stores/token-vault.ts";

type TokenFormDialogProps = {
  mode: "add" | "welcome";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dismissible?: boolean;
};

export function TokenFormDialog({
  mode,
  open,
  onOpenChange,
  dismissible = true,
}: TokenFormDialogProps) {
  const addProfile = useTokenVaultStore((state) => state.addProfile);
  const removeProfile = useTokenVaultStore((state) => state.removeProfile);
  const bootstrapping = useTokenVaultStore((state) => state.bootstrapping);
  const { bootstrapProfileById } = useTokenBootstrap();
  const rawToken = useFormDraftStore((state) => state.tokenForm.rawToken);
  const tokenError = useFormDraftStore((state) => state.tokenForm.tokenError);
  const submitting = useFormDraftStore((state) => state.tokenForm.submitting);
  const setTokenForm = useFormDraftStore((state) => state.setTokenForm);
  const resetTokenForm = useFormDraftStore((state) => state.resetTokenForm);

  const title = mode === "welcome" ? "Login" : "Add token";
  const submitLabel = mode === "welcome" ? "Login" : "Add";

  useEffect(() => {
    if (open) {
      resetTokenForm();
    }
  }, [open, resetTokenForm]);

  function handleOpenChange(nextOpen: boolean) {
    if (!dismissible && !nextOpen) {
      return;
    }

    onOpenChange(nextOpen);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTokenForm({ tokenError: null });

    const trimmedToken = rawToken.trim();
    if (!trimmedToken) {
      setTokenForm({ tokenError: "Token required" });
      return;
    }

    if (!parseTokenId(trimmedToken)) {
      setTokenForm({ tokenError: "Invalid token format" });
      return;
    }

    setTokenForm({ submitting: true });
    const createdProfileId = addProfile({
      rawToken: trimmedToken,
    });

    if (!createdProfileId) {
      setTokenForm({ tokenError: "Invalid token format", submitting: false });
      return;
    }

    const bootstrapped = await bootstrapProfileById(createdProfileId);
    setTokenForm({ submitting: false });

    if (!bootstrapped) {
      removeProfile(createdProfileId);
      setTokenForm({ tokenError: "Token rejected" });
      return;
    }

    toast.success(mode === "welcome" ? "Logged in" : "Token added");
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={dismissible}>
        <form onSubmit={(event) => void handleSubmit(event)}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <FieldGroup className="py-2">
            <Field data-invalid={tokenError ? true : undefined}>
              <FieldLabel htmlFor="token-raw">Token</FieldLabel>
              <Input
                id="token-raw"
                name="token"
                type="password"
                autoComplete="off"
                value={rawToken}
                onChange={(event) => setTokenForm({ rawToken: event.target.value })}
                aria-invalid={tokenError ? true : undefined}
                disabled={submitting || bootstrapping}
              />
              <FieldError>{tokenError}</FieldError>
            </Field>
          </FieldGroup>
          <DialogFooter>
            {dismissible ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={submitting || bootstrapping}
              >
                Cancel
              </Button>
            ) : null}
            <Button type="submit" disabled={submitting || bootstrapping}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
