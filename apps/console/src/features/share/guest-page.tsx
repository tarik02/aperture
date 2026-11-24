import type { Session } from "@aperture-browser/session-client";
import { ApertureSession, type ApertureTheme } from "@aperture-browser/session-react";
import { Button } from "@aperture-browser/ui/components/button";
import { useForm, useStore } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useState } from "react";
import { TextField } from "#/components/text-field.tsx";
import { AuthCard } from "#/features/auth/auth-card.tsx";
import { enter, LinkRefused } from "#/features/share/guest.ts";
import { useDocumentTitle } from "#/lib/document-title.ts";
import { required } from "#/lib/validation.ts";

/** How often the link is asked about while its session is shown: it may be taken back, and the session may move. */
const ASKED_EVERY_MS = 10_000;
const NAME_MOST = 40;

const isTheme = (theme: string | undefined): theme is ApertureTheme =>
  theme === "light" || theme === "dark" || theme === "system";

/** What is said in the session's place, with nothing of the console around it. */
function Said({ children, note }: { children: React.ReactNode; note: string }) {
  return (
    <AuthCard
      title="Shared session"
      data-console-guest={note}
      onSubmit={(event) => event.preventDefault()}
    >
      <p className="aperture:text-center aperture:text-sm aperture:text-muted-foreground">
        {children}
      </p>
    </AuthCard>
  );
}

/**
 * Where a share link leads: whoever opens it says what the others are to call them, and
 * is shown the session's workbench and nothing else. They have no account, and the page
 * asks the control plane for nothing but the link.
 */
export function GuestPage({ shareId }: { shareId: string }) {
  const router = useRouter();
  const queries = useQueryClient();
  const { theme, setTheme } = useTheme();
  // After the `#`, so the secret is sent nowhere when the link is opened; the browser
  // carries it once it was taken, and the address is without it from then on.
  const [secret] = useState(() => location.hash.slice(1) || undefined);
  useEffect(() => {
    if (location.hash !== "") {
      router.history.replace(location.pathname);
    }
  }, [router]);
  useDocumentTitle("Shared session");

  const key = ["share", shareId] as const;
  const link = useQuery({
    queryKey: key,
    queryFn: () => enter(shareId, { token: secret }),
    retry: false,
    refetchInterval: (query) => (query.state.status === "error" ? false : ASKED_EVERY_MS),
  });
  const naming = useMutation({
    mutationFn: (name: string) => enter(shareId, { token: secret, name }),
    onSuccess: (told) => queries.setQueryData(key, told),
  });
  const form = useForm({
    defaultValues: { name: "" },
    // What it fails with is shown below the field.
    onSubmit: ({ value }) => naming.mutateAsync(value.name.trim()).catch(() => undefined),
  });
  const submitting = useStore(form.store, (state) => state.isSubmitting);
  const expose = useCallback((session: Session | null) => {
    window.apertureSession = session ?? undefined;
  }, []);

  if (link.isError) {
    return (
      <Said note="refused">
        {link.error instanceof LinkRefused ? link.error.message : "The link was not looked up."}
      </Said>
    );
  }
  if (link.data === undefined) {
    return null;
  }
  if (link.data.name === null) {
    return (
      <AuthCard
        title="Join the shared session"
        data-console-guest="name"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <form.Field name="name" validators={{ onSubmit: required("A name") }}>
          {(field) => (
            <TextField
              field={field}
              label="Your name, as the others see it"
              autoComplete="name"
              maxLength={NAME_MOST}
              autoFocus
            />
          )}
        </form.Field>
        {naming.isError ? (
          <p role="alert" className="aperture:text-sm aperture:text-destructive">
            {naming.error.message}
          </p>
        ) : null}
        <Button type="submit" pending={submitting}>
          {link.data.role === "control" ? "Join" : "Watch"}
        </Button>
      </AuthCard>
    );
  }
  if (link.data.path === null || !link.data.running) {
    return (
      <Said note="resting">The session is not running right now. It is shown once it is.</Said>
    );
  }
  // Connected anew when the session moves: its path is another then.
  return (
    <div
      data-console-guest="session"
      className="aperture:flex aperture:h-[calc(100dvh-var(--keyboard-inset,0px))] aperture:min-h-0 aperture:flex-col aperture:pt-[env(safe-area-inset-top)] aperture:pr-[env(safe-area-inset-right)] aperture:pb-[env(safe-area-inset-bottom)] aperture:pl-[env(safe-area-inset-left)]"
    >
      <ApertureSession
        key={link.data.path}
        url={link.data.path}
        theme={isTheme(theme) ? theme : "system"}
        onThemeChange={setTheme}
        onSession={expose}
      />
    </div>
  );
}
