import { Button } from "@aperture-browser/ui/components/button";
import { useForm, useStore } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { TextField } from "#/components/text-field.tsx";
import { AuthCard } from "#/features/auth/auth-card.tsx";
import { told } from "#/lib/api.ts";
import { setPassword } from "#/lib/identity.ts";
import { atLeast } from "#/lib/validation.ts";

const MIN_LENGTH = 8;

/** Where a setup link leads: its holder sets a password, a first one or another. */
export function InvitePage() {
  const navigate = useNavigate();
  // After the `#`, so the token is sent nowhere when the link is opened.
  const token = new URLSearchParams(location.hash.slice(1)).get("token") ?? "";
  const set = useMutation({
    mutationFn: (password: string) => setPassword(token, password),
    onSuccess: () => navigate({ to: "/-/sessions" }),
  });
  const form = useForm({
    defaultValues: { password: "" },
    // What it fails with is shown below the field.
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
      {token === "" ? (
        <p role="alert" className="aperture:text-sm aperture:text-destructive">
          This link has no token in it. Ask for another.
        </p>
      ) : null}
      <form.Field name="password" validators={{ onSubmit: atLeast(MIN_LENGTH, "A password") }}>
        {(field) => (
          <TextField
            field={field}
            label="New password"
            type="password"
            autoComplete="new-password"
            autoFocus
          />
        )}
      </form.Field>
      {set.isError ? (
        <p role="alert" className="aperture:text-sm aperture:text-destructive">
          {told(set.error)}
        </p>
      ) : null}
      <Button type="submit" disabled={submitting || token === ""}>
        Set password
      </Button>
    </AuthCard>
  );
}
