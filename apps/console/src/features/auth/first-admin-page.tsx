import { Button } from "@aperture-browser/ui/components/button";
import { useForm, useStore } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { NotAnswering } from "#/components/not-answering.tsx";
import { TextField } from "#/components/text-field.tsx";
import { AuthCard } from "#/features/auth/auth-card.tsx";
import { notePasswordSet } from "#/features/auth/password-set.ts";
import { useUnanswered } from "#/lib/answering.ts";
import { call, told } from "#/lib/api.ts";
import { signIn } from "#/lib/identity.ts";
import { tellSigned } from "#/lib/sign.ts";
import { all, atLeast, email, required } from "#/lib/validation.ts";

const MIN_LENGTH = 8;

/**
 * Where the link the control plane logs leads while nobody signs in yet: its holder says
 * who they are and a password, is made the first admin, and is signed in.
 */
export function FirstAdminPage() {
  const navigate = useNavigate();
  const queries = useQueryClient();
  // After the `#`, so the token is sent nowhere when the link is opened.
  const [token] = useState(() => new URLSearchParams(location.hash.slice(1)).get("token") ?? "");
  const awaited = useQuery({
    queryKey: ["first-admin"],
    queryFn: () => call((api) => api.firstAdmin.awaited()),
    staleTime: Infinity,
  });
  const make = useMutation({
    mutationFn: async (said: { name: string; email: string; password: string }) => {
      const person = { name: said.name.trim(), email: said.email.trim() };
      await call((api) =>
        api.firstAdmin.create({ payload: { token, ...person, password: said.password } }),
      );
      const signedIn =
        (await signIn(person.email, said.password).catch(() => "not-signed-in")) === "signed-in";
      if (signedIn) {
        tellSigned("in");
      } else {
        notePasswordSet();
      }
      await queries.invalidateQueries();
    },
    onSuccess: () => navigate({ to: "/" }),
  });
  const form = useForm({
    defaultValues: { name: "", email: "", password: "" },
    // What it fails with is said below the last field.
    onSubmit: ({ value }) => make.mutateAsync(value).catch(() => undefined),
  });
  const submitting = useStore(form.store, (state) => state.isSubmitting);
  const unanswered = useUnanswered(awaited);

  if (unanswered) {
    return <NotAnswering />;
  }
  // Shown once it is known whether the link is still good: nothing moves under a pointer then.
  if (awaited.isPending) {
    return null;
  }
  // Someone who was just made is on their way in: the form stays until they are.
  if (!make.isSuccess && !make.isPending && (token === "" || awaited.data?.awaited === false)) {
    return (
      <AuthCard
        title="Set up Aperture"
        data-console-first-admin="refused"
        onSubmit={(event) => {
          event.preventDefault();
          void navigate({ to: "/" });
        }}
      >
        <p
          role="status"
          className="aperture:text-center aperture:text-sm aperture:text-muted-foreground"
        >
          {token === ""
            ? "This link has no token in it. Open the one the control plane logged."
            : "This link is good no more: someone signs in here already."}
        </p>
        <Button type="submit">Sign in</Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Set up Aperture"
      data-console-first-admin="asked"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <p className="aperture:-mt-2 aperture:text-center aperture:text-sm aperture:text-muted-foreground">
        Nobody signs in here yet. You are the first admin.
      </p>
      <form.Field name="name" validators={{ onSubmit: required("A name") }}>
        {(field) => <TextField field={field} label="Name" autoComplete="name" autoFocus />}
      </form.Field>
      <form.Field name="email" validators={{ onSubmit: all(required("An email"), email) }}>
        {(field) => <TextField field={field} label="Email" type="email" autoComplete="username" />}
      </form.Field>
      <form.Field name="password" validators={{ onSubmit: atLeast(MIN_LENGTH, "A password") }}>
        {(field) => (
          <TextField
            field={field}
            label="Password"
            type="password"
            autoComplete="new-password"
            refused={make.isError ? told(make.error, "The admin was not made.") : undefined}
          />
        )}
      </form.Field>
      <Button type="submit" pending={submitting}>
        Make the first admin
      </Button>
    </AuthCard>
  );
}
