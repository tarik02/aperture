import { Button } from "@aperture-browser/ui/components/button";
import { useForm, useStore } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { CodeInput } from "#/components/code-input.tsx";
import { TextField } from "#/components/text-field.tsx";
import { AuthCard } from "#/features/auth/auth-card.tsx";
import { takePasswordSet } from "#/features/auth/password-set.ts";
import { continueWith, refusal, useProvidersQuery } from "#/features/auth/sso.ts";
import { callAs, carry, told } from "#/lib/api.ts";
import {
  calledOff,
  giveBackupCode,
  giveCode,
  passkeysOffered,
  passkeysSupported,
  signIn,
  signInWithPasskey,
  stopAsking,
} from "#/lib/identity.ts";
import { queryKeys } from "#/lib/query-keys.ts";
import { tellSigned } from "#/lib/sign.ts";
import { keepToken } from "#/lib/token.ts";
import { all, email, required } from "#/lib/validation.ts";

type Way = "password" | "token" | "code" | "backup-code";

/** What a refusal says, for the line a field keeps for it. */
const refusedWith = (error: unknown) => told(error, "You were not signed in.");

function Another({ children, ...button }: React.ComponentProps<typeof Button>) {
  return (
    <Button type="button" variant="link" className="aperture:h-auto aperture:p-0" {...button}>
      {children}
    </Button>
  );
}

/** Who is signed in is asked anew: by the token, or by the cookies there are now. */
const useSignedIn = () => {
  const queries = useQueryClient();
  return () => {
    // The other tabs of this browser carry the same cookies now.
    tellSigned("in");
    return Promise.all([
      queries.invalidateQueries({ queryKey: queryKeys.account }),
      queries.invalidateQueries({ queryKey: queryKeys.person }),
    ]);
  };
};

/**
 * Signs a person in with their password, and a code where they turned a second factor on,
 * with a passkey, or through a provider; or anyone with an account's API token.
 */
export function SignInPage() {
  const [way, setWay] = useState<Way>("password");
  const providers = useProvidersQuery();
  // Shown once it is known which ways in there are: nothing moves under a pointer then.
  if (providers.isPending) {
    return null;
  }
  if (way === "password") {
    return <WithPassword onWay={setWay} />;
  }
  if (way === "token") {
    return <WithToken onWay={setWay} />;
  }
  // Each way of the second factor starts with nothing typed.
  return <WithCode key={way} way={way} onWay={setWay} />;
}

/** The providers there are, each a way in beside the password; why one signed nobody in. */
function Providers({ onRefused }: { onRefused: (error: unknown) => void }) {
  const router = useRouter();
  const providers = useProvidersQuery();
  const [refused] = useState(refusal);
  const leaving = useMutation({ mutationFn: continueWith, onError: onRefused });

  // What a provider answered is told once, and is not in the address for the next try.
  useEffect(() => {
    if (refused !== undefined) {
      router.history.replace(refused.without);
    }
  }, [refused, router]);

  return (
    <>
      {(providers.data ?? []).map((provider) => (
        <Button
          key={provider.id}
          type="button"
          variant="outline"
          data-console-sso={provider.id}
          disabled={leaving.isPending || leaving.isSuccess}
          onClick={() => leaving.mutate(provider.id)}
        >
          Continue with {provider.name}
        </Button>
      ))}
      {refused === undefined ? null : (
        <p
          role="alert"
          data-console-sso-refused
          className="aperture:text-sm aperture:text-destructive"
        >
          {refused.message}
        </p>
      )}
    </>
  );
}

/**
 * A passkey, which signs in by itself: asked for with a button, and offered where the
 * address is typed by a browser that does that.
 */
function WithPasskey({ onRefused }: { onRefused: (error: unknown) => void }) {
  const signedIn = useSignedIn();
  const { mutate, ...signing } = useMutation({
    mutationFn: signInWithPasskey,
    onSuccess: (answer) => (answer === "signed-in" ? signedIn() : undefined),
    onError: (error) => (calledOff(error) ? undefined : onRefused(error)),
  });

  useEffect(() => {
    let left = false;
    void passkeysOffered().then((offered) => (offered && !left ? mutate(true) : undefined));
    return () => {
      left = true;
      stopAsking();
    };
  }, [mutate]);

  if (!passkeysSupported()) {
    return null;
  }
  return (
    <Button
      type="button"
      variant="outline"
      data-console-sign-in-passkey
      // What is offered where the address is typed waits for as long as the page is there.
      disabled={(signing.isPending && signing.variables !== true) || signing.data === "signed-in"}
      onClick={() => mutate(false)}
    >
      Sign in with a passkey
    </Button>
  );
}

function WithPassword({ onWay }: { onWay: (way: Way) => void }) {
  const signedIn = useSignedIn();
  const signing = useMutation({
    mutationFn: (given: { email: string; password: string }) =>
      signIn(given.email.trim(), given.password),
    onSuccess: (answer) => (answer === "signed-in" ? signedIn() : onWay("code")),
  });
  /** What a passkey or a provider was refused with: the last way that was tried says why. */
  const [otherwise, setOtherwise] = useState<unknown>();
  // Whoever just set a password with a link that did not sign them in is told it worked.
  const [passwordSet] = useState(takePasswordSet);
  const refused = signing.isError ? signing.error : otherwise;
  const form = useForm({
    defaultValues: { email: "", password: "" },
    // What it fails with is shown below the fields.
    onSubmit: ({ value }) => {
      setOtherwise(undefined);
      return signing.mutateAsync(value).catch(() => undefined);
    },
  });
  const submitting = useStore(form.store, (state) => state.isSubmitting);

  return (
    <AuthCard
      title="Sign in to Aperture"
      data-console-sign-in="password"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      {passwordSet ? (
        <p
          role="status"
          data-console-password-set
          className="aperture:text-center aperture:text-sm aperture:text-muted-foreground"
        >
          Your password is set. Sign in with it.
        </p>
      ) : null}
      <form.Field name="email" validators={{ onSubmit: all(required("An email"), email) }}>
        {(field) => (
          <TextField
            field={field}
            label="Email"
            type="email"
            autoComplete="username webauthn"
            autoFocus
          />
        )}
      </form.Field>
      <form.Field name="password" validators={{ onSubmit: required("A password") }}>
        {(field) => (
          <TextField
            field={field}
            label="Password"
            type="password"
            autoComplete="current-password"
            refused={refused === undefined ? undefined : refusedWith(refused)}
          />
        )}
      </form.Field>
      <Button type="submit" pending={submitting}>
        Sign in
      </Button>
      <WithPasskey
        onRefused={(error) => {
          signing.reset();
          setOtherwise(error);
        }}
      />
      <Providers
        onRefused={(error) => {
          signing.reset();
          setOtherwise(error);
        }}
      />
      <div className="aperture:flex aperture:justify-center aperture:gap-4">
        <Another data-console-sign-in-way onClick={() => onWay("token")}>
          Use an API token
        </Another>
      </div>
    </AuthCard>
  );
}

function WithToken({ onWay }: { onWay: (way: Way) => void }) {
  const signing = useMutation({
    mutationFn: async (bearer: string) => {
      await callAs(bearer, (api) => api.accounts.current());
      await carry(bearer);
      return bearer;
    },
    onSuccess: keepToken,
  });
  const form = useForm({
    defaultValues: { token: "" },
    // What it fails with is shown below the field.
    onSubmit: ({ value }) => signing.mutateAsync(value.token.trim()).catch(() => undefined),
  });
  const submitting = useStore(form.store, (state) => state.isSubmitting);

  return (
    <AuthCard
      title="Sign in to Aperture"
      data-console-sign-in="token"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <form.Field name="token" validators={{ onSubmit: required("An API token") }}>
        {(field) => (
          <TextField
            field={field}
            label="API token"
            type="password"
            autoComplete="off"
            autoFocus
            placeholder="apc_…"
            refused={signing.isError ? refusedWith(signing.error) : undefined}
          />
        )}
      </form.Field>
      <Button type="submit" pending={submitting}>
        Sign in
      </Button>
      <div className="aperture:flex aperture:justify-center aperture:gap-4">
        <Another data-console-sign-in-way onClick={() => onWay("password")}>
          Use a password
        </Another>
      </div>
    </AuthCard>
  );
}

function WithCode({ way, onWay }: { way: "code" | "backup-code"; onWay: (way: Way) => void }) {
  const signedIn = useSignedIn();
  const signing = useMutation({
    mutationFn: (given: string) =>
      (way === "backup-code" ? giveBackupCode : giveCode)(given.trim()),
    onSuccess: signedIn,
  });
  const form = useForm({
    defaultValues: { code: "" },
    onSubmit: async ({ value, formApi }) => {
      try {
        await signing.mutateAsync(value.code);
      } catch {
        // A code that was not taken is typed anew; why is shown below it.
        formApi.reset();
      }
    },
  });
  const submitting = useStore(form.store, (state) => state.isSubmitting);

  return (
    <AuthCard
      title="Two-factor sign-in"
      data-console-sign-in={way}
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <form.Field
        name="code"
        validators={{ onSubmit: required(way === "code" ? "The code" : "A backup code") }}
      >
        {(field) =>
          way === "code" ? (
            <CodeInput
              value={field.state.value}
              onChange={field.handleChange}
              error={
                field.state.meta.errors.find((error) => typeof error === "string") ??
                (signing.isError ? refusedWith(signing.error) : undefined)
              }
              onComplete={() => (submitting ? undefined : void form.handleSubmit())}
            />
          ) : (
            <TextField
              field={field}
              label="Backup code"
              autoComplete="off"
              autoFocus
              refused={signing.isError ? refusedWith(signing.error) : undefined}
            />
          )
        }
      </form.Field>
      <Button type="submit" pending={submitting}>
        Sign in
      </Button>
      <div className="aperture:flex aperture:justify-center aperture:gap-4">
        <Another
          data-console-sign-in-way
          onClick={() => onWay(way === "code" ? "backup-code" : "code")}
        >
          {way === "code" ? "Use a backup code" : "Use the authenticator"}
        </Another>
        <Another onClick={() => onWay("password")}>Start over</Another>
      </div>
    </AuthCard>
  );
}
