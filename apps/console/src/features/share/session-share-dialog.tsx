import { Badge } from "@aperture-browser/ui/components/badge";
import { Button } from "@aperture-browser/ui/components/button";
import { DialogBody, DialogHeader, DialogTitle } from "@aperture-browser/ui/components/dialog";
import { useForm, useStore } from "@tanstack/react-form";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { Choice } from "#/components/choice.tsx";
import { FreshDialog } from "#/components/fresh-dialog.tsx";
import { SecretDialog } from "#/components/secret-dialog.tsx";
import { TextField } from "#/components/text-field.tsx";
import type { Session } from "#/features/session/session.queries.ts";
import {
  type Share,
  useCreateShareMutation,
  useRevokeShareMutation,
  useSharesQuery,
} from "#/features/share/share.queries.ts";
import { required } from "#/lib/validation.ts";

const ROLES = [
  { value: "watch", label: "Watch" },
  { value: "control", label: "Control" },
] as const;
type Role = (typeof ROLES)[number]["value"];

/** How long a link is good for, in hours; `never` for one that is good until it is taken back. */
const LASTS = [
  { value: "1", label: "1 hour" },
  { value: "24", label: "1 day" },
  { value: "168", label: "7 days" },
  { value: "720", label: "30 days" },
  { value: "never", label: "No expiry" },
] as const;
type Lasts = (typeof LASTS)[number]["value"];

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** When a link stops, was made and was last used, in one line. */
const story = (share: Share) => {
  const expires =
    share.expiresAt === null
      ? "no expiry"
      : share.expiresAt.epochMilliseconds <= Date.now()
        ? "expired"
        : `expires ${when.format(share.expiresAt.epochMilliseconds)}`;
  const used =
    share.lastUsedAt === null
      ? "never used"
      : `used ${when.format(share.lastUsedAt.epochMilliseconds)}`;
  return `Made ${when.format(share.createdAt.epochMilliseconds)} · ${expires} · ${used}`;
};

type SessionShareDialogProps = {
  session: Session;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * The share links into a session: each lets whoever opens it in with no account, to watch
 * or to control, until it runs out or is revoked.
 */
export function SessionShareDialog({ session, open, onOpenChange }: SessionShareDialogProps) {
  return (
    <FreshDialog
      open={open}
      onOpenChange={onOpenChange}
      className="aperture:sm:max-w-xl"
      height="30rem"
    >
      <Links session={session} open={open} />
    </FreshDialog>
  );
}

function Links({ session, open }: { session: Session; open: boolean }) {
  const shares = useSharesQuery(session.id, open);
  const create = useCreateShareMutation(session.id);
  const revoke = useRevokeShareMutation(session.id);
  const [link, setLink] = useState<string>();
  const form = useForm({
    defaultValues: { name: "", role: "watch" as Role, lasts: "24" as Lasts },
    onSubmit: async ({ value, formApi }) => {
      try {
        const made = await create.mutateAsync({
          name: value.name.trim(),
          role: value.role,
          expiresInHours: value.lasts === "never" ? undefined : Number(value.lasts),
        });
        // At the address this page is at, which is the one whoever shares it knows.
        const { pathname, hash } = new URL(made.url);
        setLink(`${location.origin}${pathname}${hash}`);
      } catch {
        // The mutation tells of it.
        return;
      }
      formApi.reset();
    },
  });
  const submitting = useStore(form.store, (state) => state.isSubmitting);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Share {session.label ?? "session"}</DialogTitle>
      </DialogHeader>
      {/* Above the links, so that it stays where it is as they come and go. */}
      <form
        data-console-share-create
        className="aperture:flex aperture:shrink-0 aperture:items-start aperture:gap-2"
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
              label="Who it is for"
              placeholder="Who it is for"
              autoComplete="off"
              labelHidden
            />
          )}
        </form.Field>
        <form.Field name="role">
          {(field) => (
            <Choice
              aria-label="What it lets them do"
              value={field.state.value}
              options={ROLES}
              onChange={field.handleChange}
            />
          )}
        </form.Field>
        <form.Field name="lasts">
          {(field) => (
            <Choice
              aria-label="How long it is good for"
              value={field.state.value}
              options={LASTS}
              onChange={field.handleChange}
            />
          )}
        </form.Field>
        <Button type="submit" disabled={submitting}>
          New link
        </Button>
      </form>
      <DialogBody>
        {shares.data?.length === 0 ? (
          <p className="aperture:text-sm aperture:text-muted-foreground">
            Nobody is let in by a link.
          </p>
        ) : null}
        <ul data-console-shares className="aperture:grid aperture:gap-3">
          {shares.data?.map((share) => (
            <li
              key={share.id}
              data-console-share={share.name}
              className="aperture:flex aperture:items-center aperture:gap-2 aperture:text-sm"
            >
              <span className="aperture:grid aperture:min-w-0 aperture:flex-1">
                <span className="aperture:truncate aperture:font-medium">{share.name}</span>
                <span className="aperture:truncate aperture:text-xs aperture:text-muted-foreground">
                  {story(share)}
                </span>
              </span>
              <Badge variant={share.role === "control" ? "default" : "outline"}>
                {share.role === "control" ? "Control" : "Watch"}
              </Badge>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Revoke ${share.name}`}
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(share.id)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      </DialogBody>
      <SecretDialog title="Share link" secret={link} onClose={() => setLink(undefined)} />
    </>
  );
}
