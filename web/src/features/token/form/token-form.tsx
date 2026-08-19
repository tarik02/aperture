import { LogIn } from "lucide-react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button.tsx";
import { DialogFooter, DialogHeader, DialogTitle } from "#/components/ui/dialog.tsx";
import { Field, FieldError, FieldGroup, FieldLabel } from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import { useTokenBootstrap } from "#/hooks/use-token-bootstrap.ts";
import { parseTokenId } from "#/lib/token-id.ts";
import { useTokenVaultStore } from "#/stores/token-vault.ts";
import { useTokenFormStore, type TokenFormMode } from "#/features/token/form/token-form.store.ts";
import type { OIDCProviders } from "#/lib/api/schemas.ts";

type TokenFormProps = {
  mode: TokenFormMode;
  dismissible?: boolean;
  oidcProviders?: OIDCProviders["providers"];
  onDone: () => void;
};

export function TokenForm({
  mode,
  dismissible = true,
  oidcProviders = [],
  onDone,
}: TokenFormProps) {
  const addProfile = useTokenVaultStore((state) => state.addProfile);
  const removeProfile = useTokenVaultStore((state) => state.removeProfile);
  const bootstrapping = useTokenVaultStore((state) => state.bootstrapping);
  const { bootstrapProfileById } = useTokenBootstrap();
  const { rawToken, tokenError, submitting } = useTokenFormStore((state) => state.formData);
  const setFormData = useTokenFormStore((state) => state.setFormData);

  const title = mode === "welcome" ? "Login" : "Add token";
  const submitLabel = mode === "welcome" ? "Login" : "Add";

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormData({ tokenError: null });

    const trimmedToken = rawToken.trim();
    if (!trimmedToken) {
      setFormData({ tokenError: "Token required" });
      return;
    }

    if (!parseTokenId(trimmedToken)) {
      setFormData({ tokenError: "Invalid token format" });
      return;
    }

    setFormData({ submitting: true });
    const createdProfileId = addProfile({
      rawToken: trimmedToken,
    });

    if (!createdProfileId) {
      setFormData({ tokenError: "Invalid token format", submitting: false });
      return;
    }

    const bootstrapped = await bootstrapProfileById(createdProfileId);
    setFormData({ submitting: false });

    if (!bootstrapped) {
      removeProfile(createdProfileId);
      setFormData({ tokenError: "Token rejected" });
      return;
    }

    toast.success(mode === "welcome" ? "Logged in" : "Token added");
    onDone();
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)}>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      {mode === "welcome" && oidcProviders.length > 0 ? (
        <div className="flex flex-col gap-2 py-2">
          {oidcProviders.map((provider) => (
            <Button
              key={provider.id}
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => {
                const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
                const query = new URLSearchParams({ returnTo });
                window.location.assign(`${provider.loginUrl}?${query.toString()}`);
              }}
            >
              <LogIn data-icon="inline-start" />
              {provider.name}
            </Button>
          ))}
        </div>
      ) : null}
      <FieldGroup className="py-2">
        <Field data-invalid={tokenError ? true : undefined}>
          <FieldLabel htmlFor="token-raw">API token</FieldLabel>
          <Input
            id="token-raw"
            name="token"
            type="password"
            autoComplete="off"
            value={rawToken}
            onChange={(event) => setFormData({ rawToken: event.target.value })}
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
            onClick={onDone}
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
  );
}
