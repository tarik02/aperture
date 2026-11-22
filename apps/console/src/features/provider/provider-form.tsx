import { Button } from "@aperture-browser/ui/components/button";
import { Field, FieldLabel } from "@aperture-browser/ui/components/field";
import { Input } from "@aperture-browser/ui/components/input";
import { Switch } from "@aperture-browser/ui/components/switch";
import { useForm, useStore } from "@tanstack/react-form";
import { useId, useState } from "react";
import { CopyButton } from "#/components/copy-button.tsx";
import { TextField } from "#/components/text-field.tsx";
import {
  problemsOf,
  useChangeProviderMutation,
  useCheckProviderMutation,
  useCreateProviderMutation,
} from "#/features/provider/provider.mutations.ts";
import type { Provider } from "#/features/provider/provider.queries.ts";
import { told } from "#/lib/api.ts";
import { reveal } from "#/lib/reveal.ts";
import { all, required } from "#/lib/validation.ts";

const SCOPES = "openid email profile";
const ID = /^(?!credential$)[a-z0-9][a-z0-9-]{0,39}$/u;
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/iu;

/** The words of a list that is typed with spaces or commas between them. */
const words = (typed: string) => typed.split(/[\s,]+/u).filter((word) => word !== "");

const idRule = ({ value }: { value: string }) =>
  ID.test(value) ? undefined : "Lowercase letters, digits and dashes.";

const addressRule = ({ value }: { value: string }) =>
  URL.canParse(value.trim()) ? undefined : "Enter the issuer's address.";

const domainsRule = ({ value }: { value: string }) =>
  words(value).every((domain) => DOMAIN.test(domain)) ? undefined : "Domains such as example.com.";

/** What came of asking the provider how it is reached, or of a save that asked it. */
type Reached =
  | { readonly state: "unasked" }
  | { readonly state: "asking" }
  | { readonly state: "reached" }
  | { readonly state: "refused"; readonly problems: ReadonlyArray<string> };

type ProviderFormProps = {
  /** The provider that is changed; a new one, without. */
  provider?: Provider | undefined;
  /** What a provider is told to send people back to, once its id is put after it. */
  callbackBase: string;
  onDone: () => void;
  /**
   * Lays the form out in whatever holds it: its title, its fields and its buttons are
   * given apart, so that a dialog and a sheet each put them where theirs go.
   */
  children: (parts: {
    readonly title: string;
    readonly fields: React.ReactNode;
    readonly actions: React.ReactNode;
  }) => React.ReactNode;
};

/** A provider as an admin says it: a new one, or one that is changed. */
export function ProviderForm({ provider, callbackBase, onDone, children }: ProviderFormProps) {
  const create = useCreateProviderMutation();
  const change = useChangeProviderMutation();
  const check = useCheckProviderMutation();
  const [reached, setReached] = useState<Reached>({ state: "unasked" });
  /** What the control plane refused of the id, said at the id. */
  const [taken, setTaken] = useState<string>();
  const issuerId = useId();
  const provisionId = useId();
  const enabledId = useId();
  const callbackId = useId();

  const form = useForm({
    defaultValues: {
      id: provider?.id ?? "",
      name: provider?.name ?? "",
      issuer: provider?.issuer ?? "",
      clientId: provider?.clientId ?? "",
      clientSecret: "",
      scopes: provider?.scopes.join(" ") ?? SCOPES,
      provision: provider?.provision ?? false,
      domains: provider?.domains.join(", ") ?? "",
      enabled: provider?.enabled ?? true,
    },
    onSubmit: async ({ value }) => {
      setTaken(undefined);
      const said = {
        id: value.id,
        name: value.name.trim(),
        issuer: value.issuer.trim(),
        clientId: value.clientId.trim(),
        clientSecret: value.clientSecret,
        scopes: words(value.scopes),
        provision: value.provision,
        domains: words(value.domains).map((domain) => domain.toLowerCase()),
        enabled: value.enabled,
      };
      try {
        await (provider === undefined ? create.mutateAsync(said) : change.mutateAsync(said));
      } catch (error) {
        const problems = problemsOf(error);
        if (typeof error === "object" && error !== null && "_tag" in error) {
          if (error._tag === "ProviderTaken") {
            setTaken(told(error));
            return;
          }
        }
        setReached({
          state: "refused",
          problems: problems.length > 0 ? problems : [told(error, "The provider was not saved.")],
        });
        return;
      }
      onDone();
    },
  });
  const submitting = useStore(form.store, (state) => state.isSubmitting);
  const id = useStore(form.store, (state) => state.values.id);

  const ask = async () => {
    setReached({ state: "asking" });
    try {
      const checked = await check.mutateAsync(form.state.values.issuer.trim());
      setReached(
        checked.ok ? { state: "reached" } : { state: "refused", problems: checked.problems },
      );
    } catch (error) {
      setReached({ state: "refused", problems: [told(error, "The provider was not asked.")] });
    }
  };

  const fields = (
    <>
      <div className="aperture:grid aperture:gap-x-4 aperture:sm:grid-cols-2">
        <form.Field name="name" validators={{ onSubmit: required("A name") }}>
          {(field) => (
            <TextField
              field={field}
              label="Name"
              autoFocus={provider === undefined}
              autoComplete="off"
            />
          )}
        </form.Field>
        <form.Field
          name="id"
          validators={provider === undefined ? { onSubmit: all(required("An ID"), idRule) } : {}}
        >
          {(field) => (
            <TextField
              field={field}
              label="ID"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              disabled={provider !== undefined}
              refused={taken}
            />
          )}
        </form.Field>
      </div>
      <form.Field name="issuer" validators={{ onSubmit: all(required("An issuer"), addressRule) }}>
        {(field) => {
          const errors: ReadonlyArray<unknown> = field.state.meta.errors;
          const said = errors.find((error) => typeof error === "string");
          return (
            <Field data-invalid={said === undefined ? undefined : true}>
              <FieldLabel htmlFor={issuerId}>Issuer URL</FieldLabel>
              <div className="aperture:flex aperture:gap-2">
                <Input
                  id={issuerId}
                  name={field.name}
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="https://id.example.com"
                  className="aperture:min-w-0 aperture:flex-1"
                  value={field.state.value}
                  aria-invalid={said !== undefined}
                  onChange={(event) => {
                    field.handleChange(event.target.value);
                    setReached({ state: "unasked" });
                  }}
                  onBlur={field.handleBlur}
                />
                <Button
                  type="button"
                  variant="outline"
                  data-console-provider-check
                  pending={reached.state === "asking"}
                  disabled={field.state.value.trim() === ""}
                  onClick={() => void ask()}
                >
                  Check
                </Button>
              </div>
              {/* Two lines are kept for what the check says, so that it moves nothing. */}
              <div
                ref={said !== undefined || reached.state === "refused" ? reveal : undefined}
                role="status"
                data-console-provider-reached={said === undefined ? reached.state : "invalid"}
                className="aperture:min-h-10 aperture:text-sm aperture:wrap-anywhere"
              >
                {said !== undefined ? (
                  <span className="aperture:text-destructive">{said}</span>
                ) : reached.state === "reached" ? (
                  <span className="aperture:text-emerald-700 aperture:dark:text-emerald-400">
                    The provider answers as it should.
                  </span>
                ) : reached.state === "refused" ? (
                  <span className="aperture:text-destructive">{reached.problems.join(" ")}</span>
                ) : null}
              </div>
            </Field>
          );
        }}
      </form.Field>
      <div className="aperture:grid aperture:gap-x-4 aperture:sm:grid-cols-2">
        <form.Field name="clientId" validators={{ onSubmit: required("A client ID") }}>
          {(field) => (
            <TextField field={field} label="Client ID" autoComplete="off" spellCheck={false} />
          )}
        </form.Field>
        <form.Field
          name="clientSecret"
          validators={provider === undefined ? { onSubmit: required("A client secret") } : {}}
        >
          {(field) => (
            <TextField
              field={field}
              label="Client secret"
              type="password"
              autoComplete="new-password"
              placeholder={provider === undefined ? undefined : "Unchanged"}
            />
          )}
        </form.Field>
      </div>
      <Field className="aperture:pb-2">
        <FieldLabel id={callbackId}>Callback URL</FieldLabel>
        <div className="aperture:flex aperture:items-start aperture:gap-2">
          {/* Shown whole, on the two lines a long one takes, so that a short one moves nothing. */}
          <code
            aria-labelledby={callbackId}
            data-console-provider-callback
            className="aperture:min-h-12 aperture:min-w-0 aperture:flex-1 aperture:rounded-lg aperture:bg-muted aperture:px-2.5 aperture:py-2 aperture:font-mono aperture:text-xs aperture:leading-4 aperture:break-all aperture:select-all"
          >
            {`${callbackBase}${id}`}
          </code>
          <CopyButton
            value={`${callbackBase}${id}`}
            label="Copy callback URL"
            size="icon"
            disabled={id === ""}
          />
        </div>
      </Field>
      <form.Field name="scopes" validators={{ onSubmit: required("A scope") }}>
        {(field) => (
          <TextField field={field} label="Scopes" autoComplete="off" spellCheck={false} />
        )}
      </form.Field>
      <form.Field name="provision">
        {(field) => (
          <div className="aperture:flex aperture:items-center aperture:justify-between aperture:gap-4">
            <label htmlFor={provisionId} className="aperture:text-sm aperture:font-medium">
              Create people on first sign-in
            </label>
            <Switch
              id={provisionId}
              data-console-provider-provision
              checked={field.state.value}
              onCheckedChange={field.handleChange}
            />
          </div>
        )}
      </form.Field>
      <form.Subscribe selector={(state) => state.values.provision}>
        {(provision) => (
          <form.Field name="domains" validators={{ onSubmit: domainsRule }}>
            {(field) => (
              <TextField
                field={field}
                label="Email domains"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="Any"
                disabled={!provision}
              />
            )}
          </form.Field>
        )}
      </form.Subscribe>
      <form.Field name="enabled">
        {(field) => (
          <div className="aperture:flex aperture:items-center aperture:justify-between aperture:gap-4">
            <label htmlFor={enabledId} className="aperture:text-sm aperture:font-medium">
              Enabled
            </label>
            <Switch
              id={enabledId}
              data-console-provider-enabled
              checked={field.state.value}
              onCheckedChange={field.handleChange}
            />
          </div>
        )}
      </form.Field>
    </>
  );

  const actions = (
    <>
      <Button type="button" variant="outline" onClick={onDone}>
        Cancel
      </Button>
      <Button type="submit" pending={submitting}>
        {provider === undefined ? "Add" : "Save"}
      </Button>
    </>
  );

  return (
    <form
      data-console-provider-form={provider?.id ?? ""}
      noValidate
      className="aperture:contents"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      {children({
        title: provider === undefined ? "New sign-in provider" : `Edit ${provider.name}`,
        fields,
        actions,
      })}
    </form>
  );
}
