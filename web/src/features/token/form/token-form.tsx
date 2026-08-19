import { useState } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import { Fingerprint, Key, KeyRound, LogIn } from "lucide-react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button.tsx";
import { DialogFooter, DialogHeader, DialogTitle } from "#/components/ui/dialog.tsx";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import { useTokenBootstrap } from "#/hooks/use-token-bootstrap.ts";
import { fetchAuthMe } from "#/lib/auth-me.ts";
import { apiClient } from "#/lib/api/client.ts";
import { parseTokenId } from "#/lib/token-id.ts";
import { useTokenVaultStore } from "#/stores/token-vault.ts";
import { useTokenFormStore, type TokenFormMode } from "#/features/token/form/token-form.store.ts";
import type { LoginMethods } from "#/lib/api/schemas.ts";

type TokenFormProps = {
  mode: TokenFormMode;
  dismissible?: boolean;
  loginMethods?: LoginMethods["methods"];
  onDone: () => void;
};

type LoginFormMethod = "password" | "api_token";

export function TokenForm({ mode, dismissible = true, loginMethods, onDone }: TokenFormProps) {
  const addProfile = useTokenVaultStore((state) => state.addProfile);
  const upsertWebSession = useTokenVaultStore((state) => state.upsertWebSession);
  const removeProfile = useTokenVaultStore((state) => state.removeProfile);
  const bootstrapping = useTokenVaultStore((state) => state.bootstrapping);
  const { bootstrapProfileById } = useTokenBootstrap();
  const { rawToken, tokenError, submitting } = useTokenFormStore((state) => state.formData);
  const setFormData = useTokenFormStore((state) => state.setFormData);
  const [selectedLoginMethod, setSelectedLoginMethod] = useState<LoginFormMethod | null>(null);
  const [passkeySubmitting, setPasskeySubmitting] = useState(false);
  const [passwordSubmitting, setPasswordSubmitting] = useState(false);
  const [passwordStep, setPasswordStep] = useState<"credentials" | "mfa">("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMFACode] = useState("");

  const busy = passkeySubmitting || passwordSubmitting || submitting || bootstrapping;
  const methods = loginMethods ?? [];
  const selectedMethodIndex = selectedLoginMethod
    ? methods.findIndex((method) => method.type === selectedLoginMethod)
    : -1;
  const activeMethodIndex = selectedMethodIndex >= 0 ? selectedMethodIndex : 0;
  const activeMethod = methods[activeMethodIndex];
  const alternativeMethods = methods.filter((_, index) => index !== activeMethodIndex);

  async function handleTokenLogin(event: React.FormEvent<HTMLFormElement>) {
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
      setPasswordStep("credentials");
      setEmail("");
      setPassword("");
      setMFACode("");
      toast.success("Logged in");
      onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Password login failed");
    } finally {
      setPasswordSubmitting(false);
    }
  }

  function startOIDCLogin(loginURL: string) {
    const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const query = new URLSearchParams({ returnTo });
    window.location.assign(`${loginURL}?${query.toString()}`);
  }

  let activeLoginControl: React.ReactNode = null;
  if (activeMethod?.type === "password") {
    activeLoginControl = (
      <form onSubmit={(event) => void handlePasswordLogin(event)}>
        <FieldGroup className="gap-4">
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
          {passwordStep === "mfa" ? (
            <Field orientation="horizontal" className="justify-end">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setPasswordStep("credentials");
                  setMFACode("");
                }}
              >
                Back
              </Button>
              <Button type="submit" disabled={busy || !mfaCode}>
                Verify
              </Button>
            </Field>
          ) : (
            <Field>
              <Button type="submit" className="w-full" disabled={busy || !email || !password}>
                Login
              </Button>
            </Field>
          )}
        </FieldGroup>
      </form>
    );
  } else if (activeMethod?.type === "api_token") {
    activeLoginControl = (
      <form onSubmit={(event) => void handleTokenLogin(event)}>
        <FieldGroup className="gap-4">
          <Field data-invalid={tokenError ? true : undefined}>
            <FieldLabel htmlFor="login-token">API token</FieldLabel>
            <Input
              id="login-token"
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
          <Field>
            <Button type="submit" className="w-full" disabled={busy}>
              Login
            </Button>
          </Field>
        </FieldGroup>
      </form>
    );
  } else if (activeMethod?.type === "passkey") {
    activeLoginControl = (
      <Button
        type="button"
        className="w-full"
        disabled={busy}
        onClick={() => void handlePasskeyLogin()}
      >
        <Fingerprint data-icon="inline-start" />
        Continue with a passkey
      </Button>
    );
  } else if (activeMethod?.type === "oidc") {
    activeLoginControl = (
      <Button
        type="button"
        className="w-full"
        disabled={busy}
        onClick={() => startOIDCLogin(activeMethod.loginUrl)}
      >
        <LogIn data-icon="inline-start" />
        {activeMethod.name}
      </Button>
    );
  }

  return (
    <div>
      {mode === "welcome" ? (
        <DialogHeader className="text-center">
          <DialogTitle>Login to Aperture</DialogTitle>
        </DialogHeader>
      ) : (
        <DialogHeader>
          <DialogTitle>Add token</DialogTitle>
        </DialogHeader>
      )}
      {mode === "welcome" ? (
        <FieldGroup className="pt-2">
          {activeLoginControl}
          {activeMethod && alternativeMethods.length > 0 ? (
            <>
              <FieldSeparator>or</FieldSeparator>
              <div className="flex flex-col gap-2">
                {alternativeMethods.map((method) => {
                  switch (method.type) {
                    case "password":
                      return (
                        <Button
                          key={method.type}
                          type="button"
                          variant="outline"
                          className="w-full"
                          disabled={busy}
                          onClick={() => setSelectedLoginMethod(method.type)}
                        >
                          <KeyRound data-icon="inline-start" />
                          Use password
                        </Button>
                      );
                    case "api_token":
                      return (
                        <Button
                          key={method.type}
                          type="button"
                          variant="outline"
                          className="w-full"
                          disabled={busy}
                          onClick={() => setSelectedLoginMethod(method.type)}
                        >
                          <Key data-icon="inline-start" />
                          Use API token
                        </Button>
                      );
                    case "passkey":
                      return (
                        <Button
                          key={method.type}
                          type="button"
                          variant="outline"
                          className="w-full"
                          disabled={busy}
                          onClick={() => void handlePasskeyLogin()}
                        >
                          <Fingerprint data-icon="inline-start" />
                          Continue with a passkey
                        </Button>
                      );
                    case "oidc":
                      return (
                        <Button
                          key={`${method.type}:${method.id}`}
                          type="button"
                          variant="outline"
                          className="w-full"
                          disabled={busy}
                          onClick={() => startOIDCLogin(method.loginUrl)}
                        >
                          <LogIn data-icon="inline-start" />
                          {method.name}
                        </Button>
                      );
                    default: {
                      const exhaustive: never = method;
                      return exhaustive;
                    }
                  }
                })}
              </div>
            </>
          ) : null}
          {loginMethods && !activeMethod ? (
            <p className="text-sm text-muted-foreground">No login methods are available.</p>
          ) : null}
        </FieldGroup>
      ) : (
        <form onSubmit={(event) => void handleTokenLogin(event)}>
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
              Add
            </Button>
          </DialogFooter>
        </form>
      )}
    </div>
  );
}
