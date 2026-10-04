import { Fragment, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ShieldAlert, X } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@aperture-browser/ui/components/alert";
import { Badge } from "@aperture-browser/ui/components/badge";
import { Button } from "@aperture-browser/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@aperture-browser/ui/components/card";
import { Checkbox } from "@aperture-browser/ui/components/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from "@aperture-browser/ui/components/field";
import { Skeleton } from "@aperture-browser/ui/components/skeleton";
import { ResourceGrantEditor } from "#/components/resources/resource-grant-editor.tsx";
import { OAuthClientAvatar } from "#/features/oauth/oauth-client-avatar.tsx";
import { queryKeys } from "#/lib/api/query-keys.ts";
import { scopeLabel } from "#/lib/scopes.ts";
import { useAuthSessionStore } from "#/stores/auth-session.ts";
import {
  ApiRequestError,
  AuthApi,
  type OAuthApproval,
  type OAuthAuthorizationRequest,
  type ResourceGrant,
  type TenantScope,
} from "@aperture-browser/api-client";
import { useRunApi } from "@aperture-browser/session-react";

export function OAuthConsentPage() {
  return (
    <div className="aperture:h-full aperture:overflow-y-auto">
      <div className="aperture:mx-auto aperture:flex aperture:min-h-full aperture:w-full aperture:max-w-xl aperture:flex-col aperture:justify-center aperture:p-4">
        <ConsentContent />
      </div>
    </div>
  );
}

function ConsentContent() {
  const runApi = useRunApi();
  const status = useAuthSessionStore((state) => state.status);
  // The router re-serializes search values it can parse as JSON, so only the address bar
  // holds the query exactly as the server validated it.
  const [query] = useState(() => window.location.search.slice(1));
  const request = useQuery({
    queryKey: queryKeys.oauthAuthorization(query),
    queryFn: ({ signal }) =>
      runApi(
        AuthApi.use((auth) => auth.getOAuthAuthorization(query)),
        { signal },
      ),
    enabled: status === "authenticated" && query !== "",
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  if (query === "") {
    return (
      <MessageCard
        title="Invalid authorization request"
        description="This link is missing its authorization parameters. Start the connection again from the app."
      />
    );
  }
  if (status === "unauthenticated") {
    return (
      <MessageCard
        title="Sign in to continue"
        description="Sign in to review the app's request to access Aperture."
      />
    );
  }
  if (request.isError) {
    const error = request.error instanceof ApiRequestError ? request.error : null;
    const invalidRequest = error?.code === "invalid_request";
    return (
      <MessageCard
        title={invalidRequest ? "Invalid authorization request" : "Could not load the request"}
        description={error?.message ?? "The authorization request could not be loaded."}
        action={invalidRequest ? null : <SwitchAccountButton />}
      />
    );
  }
  if (request.isPending) {
    return <Skeleton className="aperture:h-96 aperture:w-full aperture:rounded-xl" />;
  }
  return <ConsentForm query={query} request={request.data} />;
}

function MessageCard({
  title,
  description,
  action = null,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="aperture:text-center">
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      {action !== null ? (
        <CardFooter className="aperture:justify-center">{action}</CardFooter>
      ) : null}
    </Card>
  );
}

function SwitchAccountButton({ disabled = false }: { disabled?: boolean }) {
  const runApi = useRunApi();
  const queryClient = useQueryClient();
  const setUnauthenticated = useAuthSessionStore((state) => state.setUnauthenticated);
  const [pending, setPending] = useState(false);

  async function handleClick() {
    setPending(true);
    try {
      await runApi(AuthApi.use((auth) => auth.logoutWebSession()));
      queryClient.clear();
      setUnauthenticated();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Logout failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      type="button"
      variant="link"
      className="aperture:h-auto aperture:px-0"
      disabled={disabled || pending}
      onClick={() => void handleClick()}
    >
      Use another account
    </Button>
  );
}

interface CheckboxFieldProps {
  id: string;
  label: React.ReactNode;
  description?: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
  children?: React.ReactNode;
}

function CheckboxField({
  id,
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
  children,
}: CheckboxFieldProps) {
  return (
    <Field orientation="horizontal" data-disabled={disabled ? true : undefined}>
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onCheckedChange(next)}
      />
      <FieldContent>
        <FieldLabel htmlFor={id} className="aperture:gap-2">
          {label}
        </FieldLabel>
        {description !== undefined ? <FieldDescription>{description}</FieldDescription> : null}
        {children}
      </FieldContent>
    </Field>
  );
}

interface ConsentFormProps {
  query: string;
  request: OAuthAuthorizationRequest;
}

function ConsentForm({ query, request }: ConsentFormProps) {
  const runApi = useRunApi();
  const { client, tenants, availableScopes, requestedScopes } = request;
  const [systemAdmin, setSystemAdmin] = useState(false);
  const [allTenants, setAllTenants] = useState(false);
  const [tenantIds, setTenantIds] = useState<string[]>(() =>
    tenants.length === 1 ? tenants.map((tenant) => tenant.id) : [],
  );
  const [scopes, setScopes] = useState<TenantScope[]>(() =>
    availableScopes.filter((scope) => requestedScopes.includes(scope)),
  );
  const [allowlist, setAllowlist] = useState(false);
  const [resourceGrants, setResourceGrants] = useState<Record<string, ResourceGrant[]>>({});
  const [submitted, setSubmitted] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [pending, setPending] = useState<"approve" | "deny" | null>(null);

  const chosenTenants = allTenants
    ? tenants
    : tenants.filter((tenant) => tenantIds.includes(tenant.id));
  const chosenResourceGrants = chosenTenants.flatMap((tenant) => resourceGrants[tenant.id] ?? []);
  const tenantError = chosenTenants.length === 0 ? "Select at least one tenant" : null;
  const scopeError = scopes.length === 0 ? "Select at least one scope" : null;
  const resourceError =
    allowlist && chosenResourceGrants.length === 0
      ? "Select at least one session or snapshot"
      : null;
  const busy = pending !== null;
  const clientDetails = [
    ["Website", client.uri],
    ["Client", client.id],
    ["Redirects to", request.redirectUri],
  ] as const;

  async function respond(approval: OAuthApproval | null) {
    setPending(approval === null ? "deny" : "approve");
    setRequestError(null);
    try {
      const { redirectUrl } = await runApi(
        AuthApi.use((auth) =>
          approval === null
            ? auth.denyOAuthAuthorization(query)
            : auth.approveOAuthAuthorization(approval),
        ),
      );
      // Stays pending while the page unloads.
      window.location.assign(redirectUrl);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "The request failed");
      setPending(null);
    }
  }

  function handleApprove(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (!systemAdmin && (tenantError !== null || scopeError !== null || resourceError !== null)) {
      return;
    }
    // A system administrator grant ignores tenants, scopes and resources.
    const restricted = !systemAdmin;
    void respond({
      query,
      systemAdmin,
      tenantIds: restricted ? chosenTenants.map((tenant) => tenant.id) : [],
      scopes: restricted ? scopes : [],
      resourceMode: restricted && allowlist ? "allowlist" : "all",
      resourceGrants: restricted && allowlist ? chosenResourceGrants : [],
    });
  }

  return (
    <form onSubmit={handleApprove}>
      <Card>
        <CardHeader>
          <div className="aperture:flex aperture:items-center aperture:gap-3">
            <OAuthClientAvatar client={client} size="lg" />
            <div className="aperture:min-w-0">
              <CardTitle className="aperture:truncate">{client.name}</CardTitle>
              <CardDescription>wants to access Aperture on your behalf</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <dl className="aperture:grid aperture:grid-cols-[auto_minmax(0,1fr)] aperture:gap-x-3 aperture:gap-y-1 aperture:text-sm">
              {clientDetails.map(([term, value]) =>
                value === null ? null : (
                  <Fragment key={term}>
                    <dt className="aperture:text-muted-foreground">{term}</dt>
                    <dd className="aperture:truncate aperture:font-mono aperture:text-xs aperture:leading-5">
                      {value}
                    </dd>
                  </Fragment>
                ),
              )}
              {client.kind === "registered" ? (
                <dd className="aperture:col-span-2 aperture:text-xs aperture:text-muted-foreground">
                  This app registered itself; its name and website are not verified.
                </dd>
              ) : null}
            </dl>

            <div className="aperture:flex aperture:flex-wrap aperture:items-center aperture:gap-x-1 aperture:text-sm aperture:text-muted-foreground">
              Signed in as
              <span className="aperture:font-medium aperture:text-foreground">
                {request.user.displayName}.
              </span>
              <SwitchAccountButton disabled={busy} />
            </div>

            {request.canGrantSystemAdmin ? (
              <CheckboxField
                id="oauth-system-admin"
                label="Grant full system administrator access"
                checked={systemAdmin}
                disabled={busy}
                description="The app can do anything you can as a system administrator, in every tenant."
                onCheckedChange={setSystemAdmin}
              />
            ) : null}

            {systemAdmin ? (
              <Alert variant="destructive">
                <ShieldAlert />
                <AlertTitle>Unrestricted access</AlertTitle>
                <AlertDescription>
                  Only grant this to apps you trust completely. Tenant, scope and resource limits do
                  not apply.
                </AlertDescription>
              </Alert>
            ) : (
              <>
                <FieldSeparator />
                <FieldSet data-invalid={submitted && tenantError !== null ? true : undefined}>
                  <FieldLegend variant="label">Tenants</FieldLegend>
                  {tenants.length === 0 ? (
                    <FieldDescription>
                      You are not a member of any tenant, so there is nothing to grant.
                    </FieldDescription>
                  ) : (
                    <>
                      <CheckboxField
                        id="oauth-all-tenants"
                        label="All tenants"
                        checked={allTenants}
                        disabled={busy}
                        description="Every tenant you can access now, but not ones you join later."
                        onCheckedChange={setAllTenants}
                      />
                      {tenants.map((tenant) => {
                        const chosen = chosenTenants.includes(tenant);
                        const missingScopes = scopes.filter(
                          (scope) => !tenant.scopes.includes(scope),
                        );
                        return (
                          <CheckboxField
                            key={tenant.id}
                            id={`oauth-tenant-${tenant.id}`}
                            label={tenant.displayName}
                            checked={chosen}
                            disabled={busy || allTenants}
                            onCheckedChange={(checked) =>
                              setTenantIds((current) =>
                                checked
                                  ? [...current, tenant.id]
                                  : current.filter((id) => id !== tenant.id),
                              )
                            }
                          >
                            <div className="aperture:flex aperture:flex-wrap aperture:gap-1">
                              {tenant.scopes.map((scope) => (
                                <Badge
                                  key={scope}
                                  variant={
                                    chosen && scopes.includes(scope) ? "secondary" : "outline"
                                  }
                                  className="aperture:font-normal"
                                >
                                  {scopeLabel(scope)}
                                </Badge>
                              ))}
                            </div>
                            {chosen && missingScopes.length > 0 ? (
                              <FieldDescription>
                                {missingScopes.length === scopes.length
                                  ? "No access here: your membership has none of the selected permissions."
                                  : `Not granted here: ${missingScopes.map(scopeLabel).join(", ")}.`}
                              </FieldDescription>
                            ) : null}
                          </CheckboxField>
                        );
                      })}
                    </>
                  )}
                  <FieldError>{submitted ? tenantError : null}</FieldError>
                </FieldSet>

                <FieldSet data-invalid={submitted && scopeError !== null ? true : undefined}>
                  <FieldLegend variant="label">Permissions</FieldLegend>
                  <FieldDescription>
                    Applied in every chosen tenant, limited to your own permissions there.
                  </FieldDescription>
                  {availableScopes.map((scope) => (
                    <CheckboxField
                      key={scope}
                      id={`oauth-scope-${scope}`}
                      label={
                        <>
                          {scopeLabel(scope)}
                          {requestedScopes.includes(scope) ? (
                            <Badge variant="outline" className="aperture:font-normal">
                              Requested
                            </Badge>
                          ) : null}
                        </>
                      }
                      checked={scopes.includes(scope)}
                      disabled={busy}
                      onCheckedChange={(checked) =>
                        setScopes((current) =>
                          availableScopes.filter((item) =>
                            item === scope ? checked : current.includes(item),
                          ),
                        )
                      }
                    />
                  ))}
                  <FieldError>{submitted ? scopeError : null}</FieldError>
                </FieldSet>

                <CheckboxField
                  id="oauth-resource-allowlist"
                  label="Only specific sessions and snapshots"
                  description={
                    allowlist && chosenTenants.length === 0
                      ? "Choose tenants to pick their resources."
                      : "Otherwise the app can reach every resource in the chosen tenants."
                  }
                  checked={allowlist}
                  disabled={busy}
                  onCheckedChange={setAllowlist}
                >
                  <FieldError>{submitted ? resourceError : null}</FieldError>
                </CheckboxField>

                {allowlist
                  ? chosenTenants.map((tenant) => (
                      <ResourceGrantEditor
                        key={tenant.id}
                        id={`oauth-resource-grants-${tenant.id}`}
                        label={`Resources in ${tenant.displayName}`}
                        grants={resourceGrants[tenant.id] ?? []}
                        credentials={{
                          kind: "session",
                          authorityType: "tenant",
                          tenantId: tenant.id,
                          selectedTenantId: tenant.id,
                        }}
                        disabled={busy}
                        onChange={(grants) =>
                          setResourceGrants((current) => ({ ...current, [tenant.id]: grants }))
                        }
                      />
                    ))
                  : null}
              </>
            )}

            {requestError !== null ? (
              <Alert variant="destructive">
                <AlertDescription>{requestError}</AlertDescription>
              </Alert>
            ) : null}
          </FieldGroup>
        </CardContent>
        <CardFooter className="aperture:justify-end aperture:gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void respond(null)}
          >
            <X data-icon="inline-start" />
            {pending === "deny" ? "Denying..." : "Deny"}
          </Button>
          <Button
            type="submit"
            variant={systemAdmin ? "destructive" : "default"}
            disabled={busy || (!systemAdmin && tenants.length === 0)}
          >
            <Check data-icon="inline-start" />
            {pending === "approve" ? "Approving..." : "Approve"}
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}
