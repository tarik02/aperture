import type { Scope } from "@aperture-browser/control-api";
import { Button } from "@aperture-browser/ui/components/button";
import { Checkbox } from "@aperture-browser/ui/components/checkbox";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@aperture-browser/ui/components/field";
import { useForm, useStore } from "@tanstack/react-form";
import { useId } from "react";
import { Choice } from "#/components/choice.tsx";
import { FreshDialog } from "#/components/fresh-dialog.tsx";
import { TextField } from "#/components/text-field.tsx";
import { useAccountQuery } from "#/features/auth/auth.queries.ts";
import { SCOPES } from "#/features/token/scopes.ts";
import { useCreateTokenMutation } from "#/features/token/token.mutations.ts";
import { required } from "#/lib/validation.ts";

const EXPIRY = [
  { value: "1", label: "1 day" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "never", label: "Never" },
] as const;
type Expiry = (typeof EXPIRY)[number]["value"];

type TokenCreateDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whose token it is, where it is not the one's who is signed in: a service account's. */
  account?: { readonly id: string; readonly name: string; readonly admin: boolean } | undefined;
  /** What has the focus once it has closed, where it is opened from within another dialog. */
  finalFocus?: React.RefObject<HTMLElement | null>;
  /** Hears the secret, the one time it is told. */
  onCreated: (secret: string) => void;
};

/** A new API token: what it is called, what it is held to, and for how long it is good. */
export function TokenCreateDialog({
  open,
  onOpenChange,
  finalFocus,
  ...form
}: TokenCreateDialogProps) {
  return (
    <FreshDialog open={open} onOpenChange={onOpenChange} finalFocus={finalFocus}>
      <CreateForm {...form} onDone={() => onOpenChange(false)} />
    </FreshDialog>
  );
}

function CreateForm({
  account,
  onCreated,
  onDone,
}: Pick<TokenCreateDialogProps, "account" | "onCreated"> & { onDone: () => void }) {
  const signedIn = useAccountQuery();
  const create = useCreateTokenMutation(account?.id);
  const expiryId = useId();
  // A scope that its account has nothing of holds a token to nothing more.
  const admin = account === undefined ? signedIn.data?.admin === true : account.admin;
  const form = useForm({
    defaultValues: { name: "", scopes: [] as Scope[], expiry: "30" as Expiry },
    onSubmit: async ({ value }) => {
      try {
        const made = await create.mutateAsync({
          name: value.name.trim(),
          scopes: value.scopes.length === 0 ? undefined : value.scopes,
          expiresInDays: value.expiry === "never" ? undefined : Number(value.expiry),
        });
        onDone();
        onCreated(made.token);
      } catch {
        // The mutation tells of it.
      }
    },
  });
  const submitting = useStore(form.store, (state) => state.isSubmitting);

  return (
    <form
      data-console-token-create
      className="aperture:grid aperture:gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <DialogHeader>
        <DialogTitle>New API token</DialogTitle>
        {account === undefined ? null : (
          <DialogDescription>For the service account {account.name}.</DialogDescription>
        )}
      </DialogHeader>
      <form.Field name="name" validators={{ onSubmit: required("A name") }}>
        {(field) => <TextField field={field} label="Name" autoFocus autoComplete="off" />}
      </form.Field>
      <form.Field name="scopes">
        {(field) => (
          <FieldSet className="aperture:gap-2">
            <FieldLegend variant="label">Scopes</FieldLegend>
            <FieldDescription>
              {field.state.value.length === 0
                ? "With none ticked, it does everything this account does."
                : "It does what is ticked and nothing else. Writing includes reading."}
            </FieldDescription>
            <div data-slot="checkbox-group" className="aperture:grid aperture:gap-2">
              {SCOPES.filter((one) => admin || one.scope !== "admin").map((one) => (
                <label
                  key={one.scope}
                  className="aperture:flex aperture:items-start aperture:gap-2.5 aperture:text-sm"
                >
                  <Checkbox
                    data-console-scope={one.scope}
                    className="aperture:mt-0.5"
                    checked={field.state.value.includes(one.scope)}
                    onCheckedChange={(checked) =>
                      field.handleChange(
                        SCOPES.map((each) => each.scope).filter((scope) =>
                          scope === one.scope ? checked : field.state.value.includes(scope),
                        ),
                      )
                    }
                  />
                  <span className="aperture:grid aperture:gap-0.5">
                    <span className="aperture:font-mono aperture:text-xs">{one.scope}</span>
                    <span className="aperture:text-muted-foreground">{one.lets}</span>
                  </span>
                </label>
              ))}
            </div>
          </FieldSet>
        )}
      </form.Field>
      <form.Field name="expiry">
        {(field) => (
          <Field>
            <FieldLabel htmlFor={expiryId}>Expires in</FieldLabel>
            <Choice
              id={expiryId}
              className="aperture:w-full"
              value={field.state.value}
              options={EXPIRY}
              onChange={field.handleChange}
            />
          </Field>
        )}
      </form.Field>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          Create
        </Button>
      </DialogFooter>
    </form>
  );
}
