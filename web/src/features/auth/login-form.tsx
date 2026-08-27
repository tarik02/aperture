import { useState } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import { Fingerprint, Key, KeyRound, LogIn } from "lucide-react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button.tsx";
import { DialogHeader, DialogTitle } from "#/components/ui/dialog.tsx";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import { apiClient } from "#/lib/api/client.ts";
import { parseTokenId } from "#/lib/token-id.ts";
import { useAuthSessionStore } from "#/stores/auth-session.ts";
import type { LoginMethods } from "#/lib/api/schemas.ts";

type LoginFormProps = {
  loginMethods?: LoginMethods["methods"];
  onDone: () => void;
};

type LoginFormMethod = "password" | "api_token";

export function LoginForm({ loginMethods, onDone }: LoginFormProps) {
  const setAuthenticated = useAuthSessionStore((state) => state.setAuthenticated);
  const [selectedLoginMethod, setSelectedLoginMethod] = useState<LoginFormMethod | null>(null);
  const [rawToken, setRawToken] = useState("");
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [tokenSubmitting, setTokenSubmitting] = useState(false);
  const [passkeySubmitting, setPasskeySubmitting] = useState(false);
  const [passwordSubmitting, setPasswordSubmitting] = useState(false);
  const [passwordStep, setPasswordStep] = useState<"credentials" | "mfa">("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMFACode] = useState("");
  const [mfaMethod, setMFAMethod] = useState<"totp" | "recovery">("totp");

  const busy = passkeySubmitting || passwordSubmitting || tokenSubmitting;
  const methods = loginMethods ?? [];
  const selectedMethodIndex = selectedLoginMethod
    ? methods.findIndex((method) => method.type === selectedLoginMethod)
    : -1;
  const activeMethodIndex = selectedMethodIndex >= 0 ? selectedMethodIndex : 0;
  const activeMethod = methods[activeMethodIndex];
  const alternativeMethods = methods.filter((_, index) => index !== activeMethodIndex);

  async function handleTokenLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTokenError(null);

    const trimmedToken = rawToken.trim();
    if (!trimmedToken) {
      setTokenError("Token required");
      return;
    }

    if (!parseTokenId(trimmedToken)) {
      setTokenError("Invalid token format");
      return;
    }

    setTokenSubmitting(true);
    try {
      await apiClient.loginWithAPIToken(trimmedToken);
      setAuthenticated(await apiClient.getAuthMe());
      setRawToken("");
      toast.success("Logged in");
      onDone();
    } catch (error) {
      setTokenError(error instanceof Error ? error.message : "Token rejected");
    } finally {
      setTokenSubmitting(false);
    }
  }

  async function handlePasskeyLogin() {
    setPasskeySubmitting(true);
    try {
      const options = await apiClient.beginPasskeyLogin();
      const credential = await startAuthentication({ optionsJSON: options.publicKey });
      await apiClient.finishPasskeyLogin(credential);
      setAuthenticated(await apiClient.getAuthMe());
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
      setAuthenticated(await apiClient.getAuthMe());
      setPasswordStep("credentials");
      setEmail("");
      setPassword("");
      setMFACode("");
      setMFAMethod("totp");
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
              <FieldLabel htmlFor={`login-${mfaMethod}-code`}>
                {mfaMethod === "totp" ? "Authenticator code" : "Recovery code"}
              </FieldLabel>
              <Input
                id={`login-${mfaMethod}-code`}
                name={mfaMethod}
                autoComplete={mfaMethod === "totp" ? "one-time-code" : "off"}
                value={mfaCode}
                onChange={(event) => setMFACode(event.target.value)}
                disabled={busy}
                required
                autoFocus
              />
            </Field>
          )}
          {passwordStep === "mfa" ? (
            <Field orientation="horizontal" className="justify-between">
              <Button
                type="button"
                variant="link"
                className="px-0"
                disabled={busy}
                onClick={() => {
                  setMFAMethod(mfaMethod === "totp" ? "recovery" : "totp");
                  setMFACode("");
                }}
              >
                Use {mfaMethod === "totp" ? "a recovery code" : "an authenticator code"}
              </Button>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setPasswordStep("credentials");
                    setMFACode("");
                    setMFAMethod("totp");
                  }}
                >
                  Back
                </Button>
                <Button type="submit" disabled={busy || !mfaCode}>
                  Verify
                </Button>
              </div>
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
              onChange={(event) => setRawToken(event.target.value)}
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
      <DialogHeader className="text-center">
        <DialogTitle>Login to Aperture</DialogTitle>
      </DialogHeader>
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
    </div>
  );
}
