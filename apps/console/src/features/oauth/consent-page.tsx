import { Scope } from "@aperture-browser/control-api";
import { Button } from "@aperture-browser/ui/components/button";
import { Checkbox } from "@aperture-browser/ui/components/checkbox";
import {
  Field,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@aperture-browser/ui/components/field";
import { useForm, useStore } from "@tanstack/react-form";
import { Fragment, useId, useState } from "react";
import { ApertureMark } from "#/components/aperture-mark.tsx";
import { useDocumentTitle } from "#/lib/document-title.ts";
import { WindowTitlebar } from "#/components/window-titlebar.tsx";
import { useAccountQuery } from "#/features/auth/auth.queries.ts";
import { useApproveMutation } from "#/features/oauth/oauth.mutations.ts";
import { useAskingQuery } from "#/features/oauth/oauth.queries.ts";
import { ticked, withBrought } from "#/features/token/scopes.ts";
import {
  type ChosenResource,
  resourcesOf,
  TokenResourcesPicker,
} from "#/features/token/token-resources-picker.tsx";
import { told } from "#/lib/api.ts";

type Level = { readonly scope: Scope; readonly lets: string };

/**
 * What an app may be let do, by what it is done to: each thing in a row with the scopes
 * there are for it, the lesser first. What only an admin does stands apart from the rest.
 */
const GROUPS: ReadonlyArray<{
  readonly label: string;
  readonly things: ReadonlyArray<{ readonly name: string; readonly levels: ReadonlyArray<Level> }>;
}> = [
  {
    label: "Sessions and snapshots",
    things: [
      {
        name: "Sessions",
        levels: [
          { scope: "sessions:read", lets: "See and watch" },
          { scope: "sessions:write", lets: "Create, drive, delete" },
        ],
      },
      {
        name: "Snapshots",
        levels: [
          { scope: "snapshots:read", lets: "See" },
          { scope: "snapshots:write", lets: "Save, change, delete" },
        ],
      },
    ],
  },
  {
    label: "Workspaces and account",
    things: [
      {
        name: "Workspaces",
        levels: [
          { scope: "workspaces:read", lets: "See, with members" },
          { scope: "workspaces:write", lets: "Create, set members" },
        ],
      },
      { name: "API tokens", levels: [{ scope: "tokens:write", lets: "See, make and revoke" }] },
      {
        name: "Events",
        levels: [{ scope: "events:read", lets: "See what was done, and by whom" }],
      },
    ],
  },
  {
    label: "Administration",
    things: [
      {
        name: "Nodes and accounts",
        levels: [{ scope: "admin", lets: "All that only an admin does" }],
      },
    ],
  },
];

/** What an app that asks for nothing in particular is offered: to drive sessions. */
const USUAL: ReadonlyArray<Scope> = ["sessions:write", "snapshots:read"];

const isScope = (given: string): given is Scope => Scope.literals.some((scope) => scope === given);

/** An authorization request as the address of this page carries it. */
type Asked = {
  clientId: string;
  redirectUri: string;
  state: string | undefined;
  codeChallenge: string;
  scopes: ReadonlyArray<Scope>;
};

const askedIn = (search: string): Asked | undefined => {
  const query = new URLSearchParams(search);
  const [clientId, redirectUri, codeChallenge] = [
    query.get("client_id"),
    query.get("redirect_uri"),
    query.get("code_challenge"),
  ];
  if (clientId === null || redirectUri === null || codeChallenge === null) {
    return undefined;
  }
  return {
    clientId,
    redirectUri,
    codeChallenge,
    state: query.get("state") ?? undefined,
    scopes: (query.get("scope") ?? "").split(" ").filter(isScope),
  };
};

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  useDocumentTitle(title);
  return (
    <main className="aperture:flex aperture:h-full aperture:items-start aperture:justify-center aperture:overflow-y-auto aperture:bg-muted/40 aperture:p-4 aperture:pt-[max(1rem,env(safe-area-inset-top))] aperture:sm:items-center">
      <WindowTitlebar over />
      <div
        data-console-consent
        // A name an app gave itself may be any length: it breaks within the card.
        className="aperture:flex aperture:w-full aperture:max-w-lg aperture:min-w-0 aperture:flex-col aperture:gap-4 aperture:rounded-xl aperture:border aperture:bg-card aperture:p-6 aperture:shadow-sm aperture:wrap-anywhere aperture:sm:my-auto"
      >
        <header className="aperture:flex aperture:flex-col aperture:items-center aperture:gap-3 aperture:text-center">
          <span className="aperture:grid aperture:size-10 aperture:place-items-center aperture:rounded-xl aperture:bg-primary aperture:text-primary-foreground">
            <ApertureMark className="aperture:size-5.5" />
          </span>
          <h1 className="aperture:max-w-full aperture:text-base aperture:font-semibold">{title}</h1>
        </header>
        {children}
      </div>
    </main>
  );
}

/** Where a person decides what an app that asks to act as their account gets. */
export function ConsentPage() {
  // The address as it came: the router reads values it can as JSON, which they are not.
  const [asked] = useState(() => askedIn(location.search));
  if (asked === undefined) {
    return (
      <Frame title="Nothing to decide">
        <p className="aperture:text-center aperture:text-sm aperture:text-muted-foreground">
          This address is no request of an app. Start connecting from the app again.
        </p>
      </Frame>
    );
  }
  return <Consent asked={asked} />;
}

function Consent({ asked }: { asked: Asked }) {
  const account = useAccountQuery();
  const asking = useAskingQuery(asked);
  const approve = useApproveMutation();
  const resourcesId = useId();
  const admin = account.data?.admin === true;
  const form = useForm({
    defaultValues: {
      scopes: withBrought(
        (asked.scopes.length === 0 ? USUAL : asked.scopes).filter(
          (scope) => admin || scope !== "admin",
        ),
      ),
      // None for a grant that reaches all its account does.
      resources: [] as ReadonlyArray<ChosenResource>,
    },
    onSubmit: async ({ value }) => {
      const [first, ...others] = value.scopes;
      if (first === undefined) {
        return;
      }
      try {
        const { redirectTo } = await approve.mutateAsync({
          clientId: asked.clientId,
          redirectUri: asked.redirectUri,
          state: asked.state,
          codeChallenge: asked.codeChallenge,
          scopes: [first, ...others],
          resources: resourcesOf(value.resources),
        });
        location.assign(redirectTo);
      } catch {
        // The mutation tells of it.
      }
    },
  });
  const submitting = useStore(form.store, (state) => state.isSubmitting);

  if (asking.isPending) {
    return <Frame title="Asking who this is…">{null}</Frame>;
  }
  if (asking.isError) {
    return (
      <Frame title="This app cannot be connected">
        <p role="alert" className="aperture:text-center aperture:text-sm aperture:text-destructive">
          {told(asking.error)}
        </p>
      </Frame>
    );
  }

  // The address is one the app registered, or the request would have been refused above.
  const deny = () => {
    const back = new URL(asked.redirectUri);
    back.searchParams.set("error", "access_denied");
    if (asked.state !== undefined) {
      back.searchParams.set("state", asked.state);
    }
    location.assign(back);
  };

  return (
    <Frame title={`Connect ${asking.data.clientName}?`}>
      <form
        className="aperture:contents"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <p className="aperture:text-center aperture:text-sm aperture:text-muted-foreground">
          It acts as {account.data?.name ?? "your account"}, and goes back to{" "}
          <span className="aperture:font-mono aperture:text-xs aperture:text-foreground">
            {new URL(asked.redirectUri).host || asked.redirectUri}
          </span>
          .
        </p>
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
                <FieldLegend variant="label">It may</FieldLegend>
                <div data-slot="checkbox-group" className="aperture:grid aperture:gap-y-3">
                  {GROUPS.map((group) => ({
                    ...group,
                    things: group.things.filter((thing) =>
                      thing.levels.some((level) => admin || level.scope !== "admin"),
                    ),
                  }))
                    .filter((group) => group.things.length > 0)
                    .map((group) => (
                      <div
                        key={group.label}
                        role="group"
                        aria-label={group.label}
                        data-console-scope-group={group.label}
                        // A name to the left of what is ticked for it where there is the
                        // room, and above it on a phone.
                        className="aperture:grid aperture:grid-cols-2 aperture:gap-x-3 aperture:gap-y-2 aperture:border-t aperture:pt-3 aperture:text-sm aperture:first:border-t-0 aperture:first:pt-0 aperture:sm:grid-cols-[7.5rem_1fr_1fr]"
                      >
                        <span className="aperture:col-span-full aperture:text-xs aperture:font-medium aperture:text-muted-foreground">
                          {group.label}
                        </span>
                        {group.things.map((thing) => (
                          <Fragment key={thing.name}>
                            <span className="aperture:col-span-full aperture:sm:col-span-1">
                              {thing.name}
                            </span>
                            {thing.levels.map((level) => (
                              <label
                                key={level.scope}
                                className={
                                  thing.levels.length === 1
                                    ? "aperture:col-span-2 aperture:flex aperture:items-start aperture:gap-2.5"
                                    : "aperture:flex aperture:items-start aperture:gap-2.5"
                                }
                              >
                                <Checkbox
                                  data-console-scope={level.scope}
                                  className="aperture:mt-0.5"
                                  aria-invalid={said !== undefined}
                                  checked={field.state.value.includes(level.scope)}
                                  onCheckedChange={(checked) =>
                                    field.handleChange(
                                      ticked(field.state.value, level.scope, checked),
                                    )
                                  }
                                />
                                <span className="aperture:grid aperture:min-w-0 aperture:gap-0.5">
                                  {level.lets}
                                  <span className="aperture:font-mono aperture:text-xs aperture:text-muted-foreground">
                                    {level.scope}
                                  </span>
                                </span>
                              </label>
                            ))}
                          </Fragment>
                        ))}
                      </div>
                    ))}
                </div>
                <FieldError reserved>{said}</FieldError>
              </FieldSet>
            );
          }}
        </form.Field>
        <form.Field name="resources">
          {(field) => (
            <Field data-console-consent-reach>
              <FieldLabel htmlFor={resourcesId}>Among</FieldLabel>
              <TokenResourcesPicker
                id={resourcesId}
                chosen={field.state.value}
                onChange={field.handleChange}
              />
            </Field>
          )}
        </form.Field>
        <div className="aperture:flex aperture:justify-end aperture:gap-2">
          <Button type="button" variant="outline" data-console-consent-deny onClick={deny}>
            Deny
          </Button>
          <Button type="submit" data-console-consent-allow pending={submitting}>
            Connect
          </Button>
        </div>
      </form>
    </Frame>
  );
}
