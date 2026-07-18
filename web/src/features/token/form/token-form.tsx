import { useState } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import { Fingerprint, KeyRound, LogIn } from "lucide-react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button.tsx";
import { DialogFooter, DialogHeader, DialogTitle } from "#/components/ui/dialog.tsx";
import { Field, FieldError, FieldGroup, FieldLabel } from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Separator } from "#/components/ui/separator.tsx";
import { useTokenBootstrap } from "#/hooks/use-token-bootstrap.ts";
import { fetchAuthMe } from "#/lib/auth-me.ts";
import { apiClient } from "#/lib/api/client.ts";
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
  const upsertWebSession = useTokenVaultStore((state) => state.upsertWebSession);
  const removeProfile = useTokenVaultStore((state) => state.removeProfile);
  const bootstrapping = useTokenVaultStore((state) => state.bootstrapping);
  const { bootstrapProfileById } = useTokenBootstrap();
  const { rawToken, tokenError, submitting } = useTokenFormStore((state) => state.formData);
  const setFormData = useTokenFormStore((state) => state.setFormData);
  const [passkeySubmitting, setPasskeySubmitting] = useState(false);
  const [passwordSubmitting, setPasswordSubmitting] = useState(false);
  const [passwordStep, setPasswordStep] = useState<"credentials" | "mfa">("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMFACode] = useState("");

  const title = mode === "welcome" ? "Login" : "Add token";
  const submitLabel = mode === "welcome" ? "Login" : "Add";
  const busy = passkeySubmitting || passwordSubmitting || submitting || bootstrapping;

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

  async function handlePasskeyLogin() {
    setPasskeySubmitting(true);
    try {
      const options = await apiClient.beginPasskeyLogin();
      const credential = await startAuthentication({ optionsJSON: options.publicKey });
      await apiClient.finishPasskeyLogin(credential);
      upsertWebSession(await fetchAuthMe(null));
      toast.success("Logged in");
      onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Passkey login failed");
    } finally {
      setPasskeySubmitting(false);
    }
  }

  async function handlePasswordLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPasswordSubmitting(true);
    try {
      if (passwordStep === "credentials") {
        const result = await apiClient.loginWithPassword(email, password);
        if (result.mfaRequired) {
          setPassword("");
          setPasswordStep("mfa");
          return;
        }
      } else {
        await apiClient.completePasswordMFA(mfaCode);
      }
      upsertWebSession(await fetchAuthMe(null));
      toast.success("Logged in");
      onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Password login failed");
    } finally {
      setPasswordSubmitting(false);
    }
  }

  return (
    <div>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      {mode === "welcome" ? (
        <>
          <form onSubmit={(event) => void handlePasswordLogin(event)}>
            <FieldGroup className="py-2">
              {passwordStep === "credentials" ? (
                <>
                  <Field>
                    <FieldLabel htmlFor="login-email">Email</FieldLabel>
                    <Input
                      id="login-email"
                      name="email"
                      type="email"
                      autoComplete="username"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      disabled={busy}
                      required
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="login-password">Password</FieldLabel>
                    <Input
                      id="login-password"
                      name="password"
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      disabled={busy}
                      required
                    />
                  </Field>
                </>
              ) : (
                <Field>
                  <FieldLabel htmlFor="login-mfa-code">Authenticator or recovery code</FieldLabel>
                  <Input
                    id="login-mfa-code"
                    name="code"
                    autoComplete="one-time-code"
                    value={mfaCode}
                    onChange={(event) => setMFACode(event.target.value)}
                    disabled={busy}
                    required
                    autoFocus
                  />
                </Field>
              )}
            </FieldGroup>
            <div className="flex justify-end gap-2">
              {passwordStep === "mfa" ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setPasswordStep("credentials")}
                >
                  Back
                </Button>
              ) : null}
              <Button
                type="submit"
                disabled={busy || (passwordStep === "credentials" ? !email || !password : !mfaCode)}
              >
                <KeyRound data-icon="inline-start" />
                {passwordStep === "credentials" ? "Continue with password" : "Verify"}
              </Button>
            </div>
          </form>

          <div className="flex items-center gap-3 py-3 text-xs text-muted-foreground">
            <Separator className="flex-1" />
            <span>or</span>
            <Separator className="flex-1" />
          </div>

          <div className="flex flex-col gap-2">
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={busy}
              onClick={() => void handlePasskeyLogin()}
            >
              <Fingerprint data-icon="inline-start" />
              Continue with a passkey
            </Button>
            {oidcProviders.map((provider) => (
              <Button
                key={provider.id}
                type="button"
                variant="outline"
                className="w-full"
                disabled={busy}
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
        </>
      ) : null}
      <form onSubmit={(event) => void handleSubmit(event)}>
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
              disabled={busy}
            />
            <FieldError>{tokenError}</FieldError>
          </Field>
        </FieldGroup>
        <DialogFooter>
          {dismissible ? (
            <Button type="button" variant="outline" onClick={onDone} disabled={busy}>
              Cancel
            </Button>
          ) : null}
          <Button type="submit" disabled={busy}>
            {submitLabel}
          </Button>
        </DialogFooter>
      </form>
    </div>
  );
}
