import { useEffect, useState } from "react";
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
import { useTokenVaultStore } from "#/stores/token-vault.ts";

type TokenFormDialogProps = {
  mode: "add" | "rename" | "welcome";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profileId?: string;
  dismissible?: boolean;
};

export function TokenFormDialog({
  mode,
  open,
  onOpenChange,
  profileId,
  dismissible = true,
}: TokenFormDialogProps) {
  const addProfile = useTokenVaultStore((state) => state.addProfile);
  const removeProfile = useTokenVaultStore((state) => state.removeProfile);
  const renameProfile = useTokenVaultStore((state) => state.renameProfile);
  const profiles = useTokenVaultStore((state) => state.profiles);
  const bootstrapping = useTokenVaultStore((state) => state.bootstrapping);
  const { bootstrapProfileById } = useTokenBootstrap();

  const existingProfile = profileId ? profiles.find((profile) => profile.id === profileId) : null;

  const [rawToken, setRawToken] = useState("");
  const [label, setLabel] = useState(existingProfile?.label ?? "");
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isRename = mode === "rename";
  const title = mode === "welcome" ? "API token" : isRename ? "Rename token" : "Add token";

  useEffect(() => {
    if (open && isRename && existingProfile) {
      setLabel(existingProfile.label);
    }
  }, [existingProfile, isRename, open]);

  function resetForm() {
    setRawToken("");
    setLabel(existingProfile?.label ?? "");
    setTokenError(null);
    setLabelError(null);
    setSubmitting(false);
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!dismissible && !nextOpen) {
      return;
    }

    if (!nextOpen) {
      resetForm();
    }

    onOpenChange(nextOpen);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTokenError(null);
    setLabelError(null);

    if (isRename) {
      if (!profileId) {
        return;
      }

      const trimmedLabel = label.trim();
      if (!trimmedLabel) {
        setLabelError("Label required");
        return;
      }

      renameProfile(profileId, trimmedLabel);
      handleOpenChange(false);
      return;
    }

    const trimmedToken = rawToken.trim();
    if (!trimmedToken) {
      setTokenError("Token required");
      return;
    }

    if (!parseTokenId(trimmedToken)) {
      setTokenError("Invalid token format");
      return;
    }

    setSubmitting(true);
    const createdProfileId = addProfile({
      rawToken: trimmedToken,
      label: label.trim() || undefined,
    });

    if (!createdProfileId) {
      setTokenError("Invalid token format");
      setSubmitting(false);
      return;
    }

    const bootstrapped = await bootstrapProfileById(createdProfileId);
    setSubmitting(false);

    if (!bootstrapped) {
      removeProfile(createdProfileId);
      setTokenError("Token rejected");
      return;
    }

    toast.success("Token added");
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
            {!isRename ? (
              <Field data-invalid={tokenError ? true : undefined}>
                <FieldLabel htmlFor="token-raw">Token</FieldLabel>
                <Input
                  id="token-raw"
                  name="token"
                  type="password"
                  autoComplete="off"
                  value={rawToken}
                  onChange={(event) => setRawToken(event.target.value)}
                  aria-invalid={tokenError ? true : undefined}
                  disabled={submitting || bootstrapping}
                />
                <FieldError>{tokenError}</FieldError>
              </Field>
            ) : null}
            <Field data-invalid={labelError ? true : undefined}>
              <FieldLabel htmlFor="token-label">Label</FieldLabel>
              <Input
                id="token-label"
                name="label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                aria-invalid={labelError ? true : undefined}
                disabled={submitting || bootstrapping}
              />
              <FieldError>{labelError}</FieldError>
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
              {isRename ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
