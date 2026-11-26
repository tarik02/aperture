import type { Session } from "@aperture-browser/session-client";
import {
  ApertureSession,
  type ApertureTheme,
  type WorkbenchContribution,
} from "@aperture-browser/session-react";
import { Button } from "@aperture-browser/ui/components/button";
import { DialogFooter, DialogHeader, DialogTitle } from "@aperture-browser/ui/components/dialog";
import { DropdownMenuItem } from "@aperture-browser/ui/components/dropdown-menu";
import { useForm, useStore } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { UserPen } from "lucide-react";
import { useTheme } from "next-themes";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { FreshDialog } from "#/components/fresh-dialog.tsx";
import { NotAnswering } from "#/components/not-answering.tsx";
import { TextField } from "#/components/text-field.tsx";
import { AuthCard } from "#/features/auth/auth-card.tsx";
import { enter, LinkRefused } from "#/features/share/guest.ts";
import { notAnswering, useUnanswered } from "#/lib/answering.ts";
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

/** Opens the dialog that changes what the guest is called, from the workbench's menu. */
const Naming = createContext<() => void>(() => undefined);

function NameItem() {
  const name = useContext(Naming);
  return (
    <DropdownMenuItem data-console-guest-rename onClick={name}>
      <UserPen />
      Your name
    </DropdownMenuItem>
  );
}

/** What the guest's workbench has besides the session's own: the way to their name. */
const CONTRIBUTIONS: ReadonlyArray<WorkbenchContribution> = [
  { id: "guest.name", slot: "menu.browser", group: "guest", order: 900, component: NameItem },
  { id: "guest.name.phone", slot: "menu.phone", group: "guest", order: 900, component: NameItem },
];

/**
 * Where a share link leads: whoever opens it is shown the session's workbench at once,
 * and nothing else, under the name the link gives them until they choose their own. A
 * link to one tab shows that tab alone. They have no account, and the page asks the
 * control plane for nothing but the link.
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
  const unanswered = useUnanswered(link);
  const [naming, setNaming] = useState(false);
  const rename = useCallback(() => setNaming(true), []);
  const expose = useCallback((session: Session | null) => {
    window.apertureSession = session ?? undefined;
  }, []);

  if (unanswered) {
    return <NotAnswering />;
  }
  // What was shown before stays while Aperture does not answer whether it still may be.
  if (link.isError && !notAnswering(link.error)) {
    return (
      <Said note="refused">
        {link.error instanceof LinkRefused ? link.error.message : "The link was not looked up."}
      </Said>
    );
  }
  if (link.data === undefined) {
    return null;
  }
  if (link.data.path === null || !link.data.running) {
    return (
      <Said note="resting">The session is not running right now. It is shown once it is.</Said>
    );
  }
  const { path, name, tab } = link.data;
  // Connected anew when the session moves, its path being another then, and under a new
  // name: the session knows its members by what let them in.
  return (
    <div
      data-console-guest="session"
      data-console-guest-tab={tab ?? undefined}
      className="aperture:flex aperture:h-[calc(100dvh-var(--keyboard-inset,0px))] aperture:min-h-0 aperture:flex-col aperture:pt-[env(safe-area-inset-top)] aperture:pr-[env(safe-area-inset-right)] aperture:pb-[env(safe-area-inset-bottom)] aperture:pl-[env(safe-area-inset-left)]"
    >
      <Naming.Provider value={rename}>
        <ApertureSession
          key={`${path} ${name}`}
          url={path}
          theme={isTheme(theme) ? theme : "system"}
          onThemeChange={setTheme}
          onSession={expose}
          features={tab === null ? undefined : { tabs: false }}
          contributions={CONTRIBUTIONS}
        />
      </Naming.Provider>
      <FreshDialog open={naming} onOpenChange={setNaming}>
        <NameForm
          name={name}
          onSave={async (chosen) => {
            queries.setQueryData(key, await enter(shareId, { token: secret, name: chosen }));
          }}
          onDone={() => setNaming(false)}
        />
      </FreshDialog>
    </div>
  );
}

/** What the guest is called among the session's members, changed. */
function NameForm({
  name,
  onSave,
  onDone,
}: {
  name: string;
  onSave: (name: string) => Promise<void>;
  onDone: () => void;
}) {
  const saving = useMutation({ mutationFn: onSave, onSuccess: onDone });
  const form = useForm({
    defaultValues: { name },
    // What it fails with is shown below the field.
    onSubmit: ({ value }) => saving.mutateAsync(value.name.trim()).catch(() => undefined),
  });
  const submitting = useStore(form.store, (state) => state.isSubmitting);

  return (
    <form
      data-console-guest-name
      className="aperture:contents"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <DialogHeader>
        <DialogTitle>Your name</DialogTitle>
      </DialogHeader>
      <form.Field name="name" validators={{ onSubmit: required("A name") }}>
        {(field) => (
          <TextField
            field={field}
            label="What the others see you as"
            labelHidden
            autoComplete="name"
            maxLength={NAME_MOST}
            autoFocus
            refused={saving.isError ? saving.error.message : undefined}
          />
        )}
      </form.Field>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" pending={submitting}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}
