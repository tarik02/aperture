import type { Scope } from "@aperture-browser/control-api";
import { Button } from "@aperture-browser/ui/components/button";
import { Checkbox } from "@aperture-browser/ui/components/checkbox";
import {
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
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
import {
  type ChosenResource,
  TokenResourcesPicker,
} from "#/features/token/token-resources-picker.tsx";
import { useCreateTokenMutation } from "#/features/token/token.mutations.ts";
import { reveal } from "#/lib/reveal.ts";
import { required } from "#/lib/validation.ts";

const EXPIRY = [
  { value: "1", label: "1 day" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "never", label: "Never" },
] as const;
type Expiry = (typeof EXPIRY)[number]["value"];

const REACH = [
  { value: "all", label: "All this account reaches" },
  { value: "chosen", label: "Only chosen workspaces, sessions and snapshots" },
] as const;

const idsOf = (chosen: ReadonlyArray<ChosenResource>, kind: ChosenResource["kind"]) =>
  chosen.filter((one) => one.kind === kind).map((one) => one.id);

type TokenCreateDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whose token it is, where it is not the one's who is signed in: a service account's. */
  account?: { readonly id: string; readonly name: string; readonly admin: boolean } | undefined;
  /** What it starts held to, where what asks for the token knows what it is for. */
  initial?: { scopes: ReadonlyArray<Scope>; resources: ReadonlyArray<ChosenResource> } | undefined;
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
    <FreshDialog
      open={open}
      onOpenChange={onOpenChange}
      finalFocus={finalFocus}
      className="aperture:sm:max-w-xl"
      height="44rem"
    >
      <CreateForm {...form} onDone={() => onOpenChange(false)} />
    </FreshDialog>
  );
}

function CreateForm({
  account,
  initial,
  onCreated,
  onDone,
}: Pick<TokenCreateDialogProps, "account" | "initial" | "onCreated"> & { onDone: () => void }) {
  const signedIn = useAccountQuery();
  const create = useCreateTokenMutation(account?.id);
  const expiryId = useId();
  const reachId = useId();
  const resourcesId = useId();
  // A scope that its account has nothing of holds a token to nothing more.
  const admin = account === undefined ? signedIn.data?.admin === true : account.admin;
  const form = useForm({
    defaultValues: {
      name: "",
      scopes: [...(initial?.scopes ?? [])],
      // None for a token that reaches all its account does.
      resources: (initial === undefined || initial.resources.length === 0
        ? null
        : initial.resources) as ReadonlyArray<ChosenResource> | null,
      expiry: "30" as Expiry,
    },
    onSubmit: async ({ value }) => {
      const [first, ...others] = value.scopes;
      if (first === undefined) {
        return;
      }
      try {
        const made = await create.mutateAsync({
          name: value.name.trim(),
          scopes: [first, ...others],
          resources:
            value.resources === null
              ? undefined
              : {
                  workspaces: idsOf(value.resources, "workspaces"),
                  sessions: idsOf(value.resources, "sessions"),
                  snapshots: idsOf(value.resources, "snapshots"),
                },
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
      className="aperture:contents"
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
      <DialogBody>
        <form.Field name="name" validators={{ onSubmit: required("A name") }}>
          {(field) => <TextField field={field} label="Name" autoFocus autoComplete="off" />}
        </form.Field>
        <form.Field
          name="scopes"
          validators={{
            onSubmit: ({ value }) => (value.length === 0 ? "Tick at least one scope" : undefined),
          }}
        >
          {(field) => {
            const said = field.state.meta.errors.find((error) => typeof error === "string");
            return (
              <FieldSet
                className="aperture:gap-2"
                data-invalid={said === undefined ? undefined : true}
              >
                <FieldLegend variant="label">Scopes</FieldLegend>
                <FieldDescription>
                  It does what is ticked and nothing else. Writing includes reading.
                </FieldDescription>
                <div
                  data-slot="checkbox-group"
                  className="aperture:grid aperture:gap-x-4 aperture:gap-y-2 aperture:sm:grid-cols-2"
                >
                  {SCOPES.filter((one) => admin || one.scope !== "admin").map((one) => (
                    <label
                      key={one.scope}
                      className="aperture:flex aperture:items-start aperture:gap-2.5 aperture:text-sm"
                    >
                      <Checkbox
                        data-console-scope={one.scope}
                        className="aperture:mt-0.5"
                        aria-invalid={said !== undefined}
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
                <FieldError ref={reveal}>{said}</FieldError>
              </FieldSet>
            );
          }}
        </form.Field>
        <form.Field
          name="resources"
          validators={{
            onSubmit: ({ value }) =>
              value !== null && value.length === 0
                ? "Choose at least one workspace, session or snapshot"
                : undefined,
          }}
        >
          {(field) => {
            const said = field.state.meta.errors.find((error) => typeof error === "string");
            return (
              <Field data-console-token-reach data-invalid={said === undefined ? undefined : true}>
                <FieldLabel htmlFor={reachId}>Resources</FieldLabel>
                <Choice
                  id={reachId}
                  className="aperture:w-full"
                  value={field.state.value === null ? "all" : "chosen"}
                  options={REACH}
                  onChange={(reach) =>
                    field.handleChange(reach === "all" ? null : (field.state.value ?? []))
                  }
                />
                {field.state.value === null ? null : (
                  <>
                    <TokenResourcesPicker
                      id={resourcesId}
                      chosen={field.state.value}
                      invalid={said !== undefined}
                      onChange={field.handleChange}
                    />
                    <FieldDescription>
                      A workspace stands for all the sessions and snapshots in it, those made later
                      as well.
                    </FieldDescription>
                  </>
                )}
                <FieldError ref={reveal}>{said}</FieldError>
              </Field>
            );
          }}
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
      </DialogBody>
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
