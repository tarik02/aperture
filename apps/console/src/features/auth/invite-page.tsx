import { Button } from "@aperture-browser/ui/components/button";
import { Input } from "@aperture-browser/ui/components/input";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { AuthCard } from "#/features/auth/auth-card.tsx";
import { told } from "#/lib/api.ts";
import { setPassword } from "#/lib/identity.ts";

const MIN_LENGTH = 8;

/** Where a setup link leads: its holder sets a password, a first one or another. */
export function InvitePage() {
  const navigate = useNavigate();
  // After the `#`, so the token is sent nowhere when the link is opened.
  const token = new URLSearchParams(location.hash.slice(1)).get("token") ?? "";
  const [password, setGiven] = useState("");
  const set = useMutation({
    mutationFn: () => setPassword(token, password),
    onSuccess: () => navigate({ to: "/-/sessions" }),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    set.mutate();
  };

  return (
    <AuthCard title="Set your password" data-console-invite onSubmit={submit}>
      {token === "" ? (
        <p role="alert" className="aperture:text-sm aperture:text-destructive">
          This link has no token in it. Ask for another.
        </p>
      ) : null}
      <label className="aperture:flex aperture:flex-col aperture:gap-1.5 aperture:text-sm">
        New password
        <Input
          type="password"
          name="password"
          autoComplete="new-password"
          autoFocus
          minLength={MIN_LENGTH}
          value={password}
          onChange={(event) => setGiven(event.target.value)}
        />
      </label>
      {set.isError ? (
        <p role="alert" className="aperture:text-sm aperture:text-destructive">
          {told(set.error)}
        </p>
      ) : null}
      <Button
        type="submit"
        disabled={set.isPending || token === "" || password.length < MIN_LENGTH}
      >
        Set password
      </Button>
    </AuthCard>
  );
}
