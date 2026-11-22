import { Button } from "@aperture-browser/ui/components/button";
import { Field, FieldError, FieldLabel } from "@aperture-browser/ui/components/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@aperture-browser/ui/components/input-group";
import { ScopesPicker } from "@aperture-browser/ui/components/scopes-picker";
import { Switch } from "@aperture-browser/ui/components/switch";
import { useForm, useStore } from "@tanstack/react-form";
import { useId, useState } from "react";
import { CopyButton } from "#/components/copy-button.tsx";
import { TextField } from "#/components/text-field.tsx";
import { ProviderPresetPicker } from "#/features/provider/provider-preset-picker.tsx";
import {
  addressOf,
  COMMON_SCOPES,
  CUSTOM_OF,
  partRule,
  type Preset,
  presetOf,
  SCOPES,
} from "#/features/provider/provider-presets.ts";
import { CheckedAddress, type Reached } from "#/features/provider/provider-reached.tsx";
import {
  type Asked,
  problemsOf,
  useChangeProviderMutation,
  useCheckProviderMutation,
  useCreateProviderMutation,
} from "#/features/provider/provider.mutations.ts";
import type { Provider } from "#/features/provider/provider.queries.ts";
import { told } from "#/lib/api.ts";
import { all, required } from "#/lib/validation.ts";

const ID = /^(?!credential$)[a-z0-9][a-z0-9-]{0,39}$/u;
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/iu;
/** What every provider that speaks OpenID Connect is asked for, whatever else is. */
const ALWAYS = ["openid"] as const;
const UNASKED: Reached = { state: "unasked" };

/** The words of a list that is typed with spaces or commas between them. */
const words = (typed: string) => typed.split(/[\s,]+/u).filter((word) => word !== "");

const idRule = ({ value }: { value: string }) =>
  ID.test(value) ? undefined : "Lowercase letters, digits and dashes.";

const addressRule = ({ value }: { value: string }) =>
  URL.canParse(value.trim()) ? undefined : "Enter the issuer's address.";

const placeRule = ({ value }: { value: string }) =>
  URL.canParse(value.trim()) ? undefined : "Enter its address.";

/** Of an address that may be left out. */
const placeIfAnyRule = ({ value }: { value: string }) =>
  value.trim() === "" ? undefined : placeRule({ value });

/** What a field's rules say of what was typed into it, where they say anything. */
const saidOf = (errors: ReadonlyArray<unknown>) =>
  errors.find((error): error is string => typeof error === "string");

/** What tells one answer of a provider from that of another: all it was asked at. */
const keyOf = (asked: Asked) =>
  "issuer" in asked ? asked.issuer : Object.values(asked.endpoints).join(" ");

/** Whether there is anything to ask at yet. */
const whole = (asked: Asked) =>
  "issuer" in asked
    ? asked.issuer !== ""
    : [asked.endpoints.authorization, asked.endpoints.token, asked.endpoints.userInfo].every(
        (place) => place !== "",
      );

const domainsRule = ({ value }: { value: string }) =>
  words(value).every((domain) => DOMAIN.test(domain)) ? undefined : "Domains such as example.com.";

const alike = (one: ReadonlyArray<string>, other: ReadonlyArray<string>) =>
  one.length === other.length && one.every((scope) => other.includes(scope));

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
  /** What came of asking a provider, and where it was asked: what came of another is not shown. */
  const [asked, setAsked] = useState<{ readonly at: string; readonly reached: Reached }>({
    at: "",
    reached: UNASKED,
  });
  /** The scopes the provider said it gives, when it was last asked and reached. */
  const [given, setGiven] = useState<ReadonlyArray<string>>([]);
  /** What the control plane refused of the id, said at the id. */
  const [taken, setTaken] = useState<string>();
  const provisionId = useId();
  const enabledId = useId();
  const callbackId = useId();
  const scopesId = useId();

  const form = useForm({
    defaultValues: {
      // What it was made from is kept nowhere: one that is changed is as one typed whole.
      preset: CUSTOM_OF[provider?.kind ?? "oidc"] as string,
      parts: {} as Record<string, string>,
      id: provider?.id ?? "",
      name: provider?.name ?? "",
      issuer: provider?.issuer ?? "",
      authorization: provider?.endpoints?.authorization ?? "",
      token: provider?.endpoints?.token ?? "",
      userInfo: provider?.endpoints?.userInfo ?? "",
      emails: provider?.endpoints?.emails ?? "",
      clientId: provider?.clientId ?? "",
      clientSecret: "",
      scopes: provider?.scopes ?? [...SCOPES],
      provision: provider?.provision ?? false,
      domains: provider?.domains.join(", ") ?? "",
      enabled: provider?.enabled ?? true,
    },
    onSubmit: async ({ value }) => {
      setTaken(undefined);
      const now = askedOf(value);
      const said = {
        id: value.id,
        name: value.name.trim(),
        ...("issuer" in now
          ? { kind: "oidc" as const, issuer: now.issuer }
          : { kind: "oauth2" as const, endpoints: now.endpoints }),
        clientId: value.clientId.trim(),
        clientSecret: value.clientSecret,
        scopes: value.scopes,
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
        setAsked({
          at: keyOf(now),
          reached: {
            state: "refused",
            problems: problems.length > 0 ? problems : [told(error, "The provider was not saved.")],
          },
        });
        return;
      }
      onDone();
    },
  });
  const submitting = useStore(form.store, (state) => state.isSubmitting);
  const id = useStore(form.store, (state) => state.values.id);
  const preset = presetOf(useStore(form.store, (state) => state.values.preset));
  /** Whether its address is made of what is typed elsewhere, or is the provider's own. */
  const derived =
    preset.kind === "oidc" ? preset.issuer !== undefined : preset.endpoints !== undefined;
  /**
   * Where the provider is asked as the form has it now: its issuer, typed or made of what
   * was typed for the preset's parts, or the places one without an issuer is asked at.
   */
  const askedOf = (value: typeof form.state.values): Asked => {
    const of = presetOf(value.preset);
    if (of.kind === "oauth2") {
      return {
        endpoints:
          of.endpoints === undefined
            ? {
                authorization: value.authorization.trim(),
                token: value.token.trim(),
                userInfo: value.userInfo.trim(),
                emails: value.emails.trim(),
              }
            : { ...of.endpoints, emails: of.endpoints.emails ?? "" },
      };
    }
    return {
      issuer:
        of.issuer === undefined
          ? value.issuer.trim()
          : addressOf(of, of.issuer, value.parts, value.clientId),
    };
  };
  const at = useStore(form.store, (state) => keyOf(askedOf(state.values)));
  /** The address that is read where it is not typed. */
  const shown = useStore(form.store, (state) => {
    const now = askedOf(state.values);
    return "issuer" in now ? now.issuer : now.endpoints.authorization;
  });
  const reached = asked.at === at ? asked.reached : UNASKED;
  const callback = `${callbackBase}${id}`;

  const ask = async () => {
    const now = askedOf(form.state.values);
    if (!whole(now)) {
      // Nothing to ask at yet: what is missing of the address is said where it is typed.
      const missing =
        "issuer" in now
          ? [...preset.parts.map((part) => `parts.${part.name}` as const), "issuer" as const]
          : (["authorization", "token", "userInfo"] as const);
      for (const name of missing) {
        void form.validateField(name, "submit");
      }
      return;
    }
    setAsked({ at, reached: { state: "asking" } });
    try {
      const checked = await check.mutateAsync(now);
      setAsked({
        at,
        reached: checked.ok
          ? { state: "reached" }
          : { state: "refused", problems: checked.problems },
      });
      if (checked.ok) {
        setGiven(checked.scopes);
      }
    } catch (error) {
      setAsked({
        at,
        reached: { state: "refused", problems: [told(error, "The provider was not asked.")] },
      });
    }
  };

  /**
   * Fills in what is known of a provider. What was typed stays: a name, an id and scopes
   * are another's only while they are still what the provider before had them be.
   */
  const choose = (next: Preset) => {
    const { values } = form.state;
    const was = presetOf(values.preset);
    form.setFieldValue("preset", next.id);
    form.setFieldValue("parts", Object.fromEntries(next.parts.map((part) => [part.name, ""])));
    if (values.name.trim() === "" || values.name === was.name) {
      form.setFieldValue("name", next.providerId === "" ? "" : next.name);
    }
    if (values.id === "" || values.id === was.providerId) {
      form.setFieldValue("id", next.providerId);
    }
    if (values.issuer.trim() === "" || values.issuer === (was.issuerAt?.first ?? "")) {
      form.setFieldValue("issuer", next.issuerAt?.first ?? "");
    }
    if (next.kind !== was.kind) {
      for (const place of ["authorization", "token", "userInfo", "emails"] as const) {
        form.setFieldValue(place, "");
      }
    }
    if (alike(values.scopes, was.scopes)) {
      form.setFieldValue("scopes", [...next.scopes]);
    }
    setGiven([]);
    // What came of asking the provider before says nothing of this one.
    setAsked({ at: "", reached: UNASKED });
  };

  const fields = (
    <>
      {provider === undefined ? <ProviderPresetPicker value={preset.id} onChange={choose} /> : null}
      <div className="aperture:grid aperture:gap-x-4 aperture:gap-y-4 aperture:sm:grid-cols-2">
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
      {preset.parts.length === 0 ? null : (
        <div
          className={
            preset.parts.length > 1
              ? "aperture:grid aperture:gap-x-4 aperture:gap-y-4 aperture:sm:grid-cols-2"
              : undefined
          }
        >
          {preset.parts.map((part) => (
            <form.Field
              key={`${preset.id}:${part.name}`}
              name={`parts.${part.name}`}
              validators={{ onSubmit: partRule(part) }}
            >
              {(field) => (
                <TextField
                  field={field}
                  label={part.label}
                  placeholder={part.placeholder}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  inputMode={part.kind === "address" ? "url" : undefined}
                />
              )}
            </form.Field>
          ))}
        </div>
      )}
      {preset.kind === "oidc" ? (
        <form.Field
          name="issuer"
          validators={derived ? {} : { onSubmit: all(required("An issuer"), addressRule) }}
        >
          {(field) => (
            <CheckedAddress
              label="Issuer URL"
              name={field.name}
              value={derived ? shown : field.state.value}
              placeholder={preset.issuer ?? preset.issuerAt?.placeholder}
              fixed={derived}
              said={derived ? undefined : saidOf(field.state.meta.errors)}
              reached={reached}
              onChange={field.handleChange}
              onBlur={field.handleBlur}
              onCheck={() => void ask()}
            />
          )}
        </form.Field>
      ) : (
        <>
          <form.Field
            name="authorization"
            validators={derived ? {} : { onSubmit: all(required("An address"), placeRule) }}
          >
            {(field) => (
              <CheckedAddress
                label="Authorization URL"
                name={field.name}
                value={derived ? shown : field.state.value}
                placeholder="https://id.example.com/oauth/authorize"
                fixed={derived}
                said={derived ? undefined : saidOf(field.state.meta.errors)}
                reached={reached}
                onChange={field.handleChange}
                onBlur={field.handleBlur}
                onCheck={() => void ask()}
              />
            )}
          </form.Field>
          {/* Those of a provider that is known are its own, and the same for everyone. */}
          {derived ? null : (
            <>
              <form.Field
                name="token"
                validators={{ onSubmit: all(required("An address"), placeRule) }}
              >
                {(field) => (
                  <TextField
                    field={field}
                    label="Token URL"
                    type="url"
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="https://id.example.com/oauth/token"
                  />
                )}
              </form.Field>
              <div className="aperture:grid aperture:gap-x-4 aperture:gap-y-4 aperture:sm:grid-cols-2">
                <form.Field
                  name="userInfo"
                  validators={{ onSubmit: all(required("An address"), placeRule) }}
                >
                  {(field) => (
                    <TextField
                      field={field}
                      label="User info URL"
                      type="url"
                      inputMode="url"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  )}
                </form.Field>
                <form.Field name="emails" validators={{ onSubmit: placeIfAnyRule }}>
                  {(field) => (
                    <TextField
                      field={field}
                      label="Emails URL"
                      type="url"
                      inputMode="url"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="None"
                    />
                  )}
                </form.Field>
              </div>
            </>
          )}
        </>
      )}
      <div className="aperture:grid aperture:gap-x-4 aperture:gap-y-4 aperture:sm:grid-cols-2">
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
      <Field>
        <FieldLabel htmlFor={callbackId}>Callback URL</FieldLabel>
        <InputGroup className="aperture:bg-muted/50 aperture:dark:bg-muted/50">
          {/* One line, which scrolls where the address is longer than it. */}
          <InputGroupInput
            id={callbackId}
            readOnly
            data-console-provider-callback
            className="aperture:font-mono aperture:text-xs aperture:md:text-xs"
            value={callback}
            onFocus={(event) => event.target.select()}
          />
          <InputGroupAddon align="inline-end">
            <CopyButton value={callback} label="Copy callback URL" variant="ghost" size="icon-xs" />
          </InputGroupAddon>
        </InputGroup>
        <FieldError reserved />
      </Field>
      <form.Field name="scopes">
        {(field) => (
          <Field>
            <FieldLabel htmlFor={scopesId}>Scopes</FieldLabel>
            <ScopesPicker
              id={scopesId}
              value={field.state.value}
              onValueChange={(scopes) => field.handleChange([...scopes])}
              placeholder="None"
              // What one that speaks OAuth 2.0 alone is asked for is its own to name.
              required={preset.kind === "oidc" ? ALWAYS : []}
              groups={[
                { label: "Common", scopes: preset.kind === "oidc" ? COMMON_SCOPES : [] },
                { label: preset.name, scopes: [...preset.scopes, ...preset.offers] },
                { label: "The provider gives", scopes: given },
              ]}
            />
            <FieldError reserved />
          </Field>
        )}
      </form.Field>
      <form.Field name="provision">
        {(field) => (
          <Field orientation="horizontal" className="aperture:min-h-(--control-height)">
            <FieldLabel htmlFor={provisionId}>Create people on first sign-in</FieldLabel>
            <Switch
              id={provisionId}
              data-console-provider-provision
              checked={field.state.value}
              onCheckedChange={field.handleChange}
            />
          </Field>
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
                noted={
                  provision && preset.open && field.state.value.trim() === ""
                    ? `Anyone with a ${preset.name} account is made a person.`
                    : undefined
                }
              />
            )}
          </form.Field>
        )}
      </form.Subscribe>
      <form.Field name="enabled">
        {(field) => (
          <Field orientation="horizontal" className="aperture:min-h-(--control-height)">
            <FieldLabel htmlFor={enabledId}>Enabled</FieldLabel>
            <Switch
              id={enabledId}
              data-console-provider-enabled
              checked={field.state.value}
              onCheckedChange={field.handleChange}
            />
          </Field>
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
