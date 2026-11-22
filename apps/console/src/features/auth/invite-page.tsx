import { Button } from "@aperture-browser/ui/components/button";
import { useForm, useStore } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { TextField } from "#/components/text-field.tsx";
import { AuthCard } from "#/features/auth/auth-card.tsx";
import { notePasswordSet } from "#/features/auth/password-set.ts";
import { told } from "#/lib/api.ts";
import { setPassword, signIn } from "#/lib/identity.ts";
import { tellSigned } from "#/lib/sign.ts";
import { atLeast } from "#/lib/validation.ts";

const MIN_LENGTH = 8;

/**
 * Where a setup link leads: its holder sets a password, a first one or another, and is
 * signed in with it where the link says whose it is and nothing else is asked of them.
 */
export function InvitePage() {
  const navigate = useNavigate();
  const queries = useQueryClient();
  // After the `#`, so the token is sent nowhere when the link is opened.
  const [{ token, email }] = useState(() => {
    const said = new URLSearchParams(location.hash.slice(1));
    return { token: said.get("token") ?? "", email: said.get("email") ?? "" };
  });
  const set = useMutation({
    mutationFn: async (password: string) => {
      await setPassword(token, password);
      // Whoever has a second factor is asked its code, and one whose link does not say
      // who they are their address: both on the page that signs in.
      const signedIn =
        email !== "" &&
        (await signIn(email, password).catch(() => "not-signed-in")) === "signed-in";
      if (signedIn) {
        tellSigned("in");
      } else {
        notePasswordSet();
      }
      await queries.invalidateQueries();
    },
    onSuccess: () => navigate({ to: "/-/sessions" }),
  });
  const form = useForm({
    defaultValues: { password: "" },
    // What it fails with is said below the field.
    onSubmit: ({ value }) => set.mutateAsync(value.password).catch(() => undefined),
  });
  const submitting = useStore(form.store, (state) => state.isSubmitting);

  return (
    <AuthCard
      title="Set your password"
      data-console-invite
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      {email === "" ? null : (
        <>
          <p
            data-console-invite-email
            className="aperture:-mt-2 aperture:text-center aperture:text-sm aperture:text-muted-foreground aperture:wrap-anywhere"
          >
            {email}
          </p>
          {/* For a browser that keeps passwords: whose the new one is. */}
          <input type="email" name="email" autoComplete="username" readOnly hidden value={email} />
        </>
      )}
      <form.Field name="password" validators={{ onSubmit: atLeast(MIN_LENGTH, "A password") }}>
        {(field) => (
          <TextField
            field={field}
            label="New password"
            type="password"
            autoComplete="new-password"
            autoFocus
            refused={
              token === ""
                ? "This link has no token in it. Ask for another."
                : set.isError
                  ? told(set.error, "The password was not set.")
                  : undefined
            }
          />
        )}
      </form.Field>
      <Button type="submit" pending={submitting} disabled={token === ""}>
        Set password
      </Button>
    </AuthCard>
  );
}
