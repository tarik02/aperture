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
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@aperture-browser/ui/components/field";
import { useForm, useStore } from "@tanstack/react-form";
import { useId, useState } from "react";
import { Choice } from "#/components/choice.tsx";
import { FreshDialog } from "#/components/fresh-dialog.tsx";
import { TextField } from "#/components/text-field.tsx";
import { useAccess } from "#/features/auth/access.ts";
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
      side="right"
      className="aperture:sm:max-w-xl"
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
  const access = useAccess();
  const create = useCreateTokenMutation(account?.id);
  const expiryId = useId();
  const reachId = useId();
  const resourcesId = useId();
  // A scope that its account has nothing of holds a token to nothing more, and a token
  // makes none of its own account that does more than itself.
  const offered = SCOPES.filter((one) =>
    account === undefined ? access.may(one.scope) : account.admin || one.scope !== "admin",
  );
  const form = useForm({
    defaultValues: {
      name: "",
      scopes: (initial?.scopes ?? []).filter((scope) => offered.some((one) => one.scope === scope)),
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
  /** Whether what each scope lets a token do is said below it, and not only where a pointer rests. */
  const [explained, setExplained] = useState(false);

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
      {/* All it ever asks and says: what each scope does, and held to chosen resources. */}
      <DialogBody height="calc(26.25rem + 5.5 * var(--control-height))">
        <form.Field name="name" validators={{ onSubmit: required("A name") }}>
          {(field) => <TextField field={field} label="Name" autoFocus autoComplete="off" />}
        </form.Field>
        <form.Field
          name="scopes"
          validators={{
            onSubmit: ({ value }) => (value.length === 0 ? "Tick at least one scope." : undefined),
          }}
        >
          {(field) => {
            const said = field.state.meta.errors.find((error) => typeof error === "string");
            return (
              <FieldSet
                className="aperture:gap-2"
                data-invalid={said === undefined ? undefined : true}
              >
                {/* What opens the words is beside the legend, above them: it stays where it was pressed. */}
                <FieldLegend
                  variant="label"
                  className="aperture:flex aperture:w-full aperture:items-baseline aperture:justify-between aperture:gap-2"
                >
                  Scopes
                  <Button
                    type="button"
                    variant="link"
                    data-console-scopes-explain
                    aria-expanded={explained}
                    className="aperture:h-auto aperture:p-0 aperture:text-xs aperture:font-normal aperture:text-muted-foreground"
                    onClick={() => setExplained(!explained)}
                  >
                    {explained ? "Hide what they do" : "What they do"}
                  </Button>
                </FieldLegend>
                <div
                  data-slot="checkbox-group"
                  className="aperture:grid aperture:gap-x-4 aperture:gap-y-2 aperture:sm:grid-cols-2"
                >
                  {offered.map((one) => (
                    <label
                      key={one.scope}
                      title={one.lets}
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
                        {explained ? (
                          <span className="aperture:text-muted-foreground">{one.lets}</span>
                        ) : null}
                      </span>
                    </label>
                  ))}
                </div>
                <FieldError ref={reveal} reserved>
                  {said}
                </FieldError>
              </FieldSet>
            );
          }}
        </form.Field>
        <form.Field
          name="resources"
          validators={{
            onSubmit: ({ value }) =>
              value !== null && value.length === 0
                ? "Choose at least one workspace, session or snapshot."
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
                  <TokenResourcesPicker
                    id={resourcesId}
                    chosen={field.state.value}
                    invalid={said !== undefined}
                    onChange={field.handleChange}
                  />
                )}
                <FieldError ref={reveal} reserved>
                  {said}
                </FieldError>
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
        <Button type="submit" pending={submitting}>
          Create
        </Button>
      </DialogFooter>
    </form>
  );
}
