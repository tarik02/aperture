import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { Alert, AlertDescription } from "#/components/ui/alert.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "#/components/ui/card.tsx";
import { Field, FieldError, FieldGroup, FieldLabel } from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { apiClient } from "#/lib/api/client.ts";
import { useAuthSessionStore } from "#/stores/auth-session.ts";

const invitationStorageKey = "aperture.user-invitation";

type InvitationState = { kind: "loading" } | { kind: "missing" } | { kind: "ready"; token: string };

export const Route = createFileRoute("/invite")({
  component: InviteRoute,
});

function InviteRoute() {
  const navigate = useNavigate();
  const setAuthenticated = useAuthSessionStore((state) => state.setAuthenticated);
  const [invitation, setInvitation] = useState<InvitationState>({ kind: "loading" });
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const fragmentToken = new URLSearchParams(window.location.hash.slice(1)).get("token");
    if (window.location.hash) {
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
      if (!fragmentToken) {
        window.sessionStorage.removeItem(invitationStorageKey);
        setInvitation({ kind: "missing" });
        return;
      }
      window.sessionStorage.setItem(invitationStorageKey, fragmentToken);
      setInvitation({ kind: "ready", token: fragmentToken });
      return;
    }

    const storedToken = window.sessionStorage.getItem(invitationStorageKey);
    setInvitation(storedToken ? { kind: "ready", token: storedToken } : { kind: "missing" });
  }, []);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (invitation.kind !== "ready") {
      return;
    }
    if (password !== confirmation) {
      setPasswordError("Passwords do not match");
      return;
    }

    setPending(true);
    setPasswordError(null);
    setRequestError(null);
    try {
      await apiClient.acceptUserInvitation(invitation.token, password);
      window.sessionStorage.removeItem(invitationStorageKey);
      setAuthenticated(await apiClient.getAuthMe());
      await navigate({ to: "/-/sessions" });
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "Password update failed");
    } finally {
      setPending(false);
    }
  }

  if (invitation.kind === "loading") {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <Skeleton className="mx-auto h-5 w-40" />
            <Skeleton className="mx-auto h-4 w-64" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-28 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (invitation.kind === "missing") {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <CardTitle>Invalid password link</CardTitle>
            <CardDescription>Ask an administrator to create a new link.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center p-4">
      <form className="w-full max-w-sm" onSubmit={(event) => void handleSubmit(event)}>
        <Card>
          <CardHeader className="text-center">
            <CardTitle>Choose your Aperture password</CardTitle>
            <CardDescription>Set a new password to continue.</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="invitation-password">Password</FieldLabel>
                <Input
                  id="invitation-password"
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  maxLength={1024}
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setPasswordError(null);
                  }}
                  disabled={pending}
                  autoFocus
                  required
                />
              </Field>
              <Field data-invalid={passwordError ? true : undefined}>
                <FieldLabel htmlFor="invitation-password-confirmation">Confirm password</FieldLabel>
                <Input
                  id="invitation-password-confirmation"
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  maxLength={1024}
                  value={confirmation}
                  onChange={(event) => {
                    setConfirmation(event.target.value);
                    setPasswordError(null);
                  }}
                  aria-invalid={passwordError ? true : undefined}
                  disabled={pending}
                  required
                />
                <FieldError>{passwordError}</FieldError>
              </Field>
              {requestError ? (
                <Alert variant="destructive">
                  <AlertDescription>{requestError}</AlertDescription>
                </Alert>
              ) : null}
            </FieldGroup>
          </CardContent>
          <CardFooter>
            <Button type="submit" className="w-full" disabled={pending}>
              <KeyRound data-icon="inline-start" />
              {pending ? "Saving..." : "Set password"}
            </Button>
          </CardFooter>
        </Card>
      </form>
    </div>
  );
}
