import { useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@aperture-browser/ui/components/select";
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
  type ResourceMode,
  type TenantScope,
} from "@aperture-browser/api-client";
import { useRunApi } from "@aperture-browser/session-react";

const RESOURCE_MODE_OPTIONS = [
  { value: "all", label: "All resources" },
  { value: "allowlist", label: "Specific sessions and snapshots" },
];

export function OAuthConsentPage() {
  const runApi = useRunApi();
  const status = useAuthSessionStore((state) => state.status);
  // Read once from the address bar: the router re-serializes search values it can parse as
  // JSON, so its copy may differ from the authorization request the server validated.
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
      <ConsentLayout>
        <ErrorCard
          title="Invalid authorization request"
          description="This link is missing its authorization parameters. Start the connection again from the app."
        />
      </ConsentLayout>
    );
  }

  if (status === "unauthenticated") {
    return (
      <ConsentLayout>
        <Card>
          <CardHeader className="aperture:text-center">
            <CardTitle>Sign in to continue</CardTitle>
            <CardDescription>
              Sign in to review the app's request to access Aperture.
            </CardDescription>
          </CardHeader>
        </Card>
      </ConsentLayout>
    );
  }

  if (request.isError) {
    const invalidRequest =
      request.error instanceof ApiRequestError && request.error.code === "invalid_request";
    return (
      <ConsentLayout>
        <ErrorCard
          title={invalidRequest ? "Invalid authorization request" : "Could not load the request"}
          description={
            request.error instanceof ApiRequestError
              ? request.error.message
              : "The authorization request could not be loaded."
          }
          action={invalidRequest ? null : <SwitchAccountButton />}
        />
      </ConsentLayout>
    );
  }

  if (request.isPending) {
    return (
      <ConsentLayout>
        <Card>
          <CardHeader>
            <Skeleton className="aperture:h-10 aperture:w-10" />
            <Skeleton className="aperture:h-5 aperture:w-64" />
            <Skeleton className="aperture:h-4 aperture:w-48" />
          </CardHeader>
          <CardContent>
            <Skeleton className="aperture:h-48 aperture:w-full" />
          </CardContent>
        </Card>
      </ConsentLayout>
    );
  }

  return (
    <ConsentLayout>
      <ConsentForm query={query} request={request.data} />
    </ConsentLayout>
  );
}

function ConsentLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="aperture:h-full aperture:overflow-y-auto">
      <div className="aperture:mx-auto aperture:flex aperture:min-h-full aperture:w-full aperture:max-w-xl aperture:flex-col aperture:justify-center aperture:p-4">
        {children}
      </div>
    </div>
  );
}

interface ErrorCardProps {
  title: string;
  description: string;
  action?: React.ReactNode;
}

function ErrorCard({ title, description, action = null }: ErrorCardProps) {
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

interface ConsentFormProps {
  query: string;
  request: OAuthAuthorizationRequest;
}

function ConsentForm({ query, request }: ConsentFormProps) {
  const runApi = useRunApi();
  const { client, tenants, availableScopes } = request;
  const [systemAdmin, setSystemAdmin] = useState(false);
  const [allTenants, setAllTenants] = useState(false);
  const [tenantIds, setTenantIds] = useState<string[]>(() =>
    tenants.length === 1 ? tenants.map((tenant) => tenant.id) : [],
  );
  const [scopes, setScopes] = useState<TenantScope[]>(() =>
    availableScopes.filter((scope) => request.requestedScopes.includes(scope)),
  );
  const [resourceMode, setResourceMode] = useState<ResourceMode>("all");
  const [resourceGrants, setResourceGrants] = useState<Record<string, ResourceGrant[]>>({});
  const [tenantError, setTenantError] = useState<string | null>(null);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [resourceError, setResourceError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [pending, setPending] = useState<"approve" | "deny" | null>(null);

  const chosenTenants = allTenants
    ? tenants
    : tenants.filter((tenant) => tenantIds.includes(tenant.id));
  const chosenResourceGrants = chosenTenants.flatMap((tenant) => resourceGrants[tenant.id] ?? []);
  const busy = pending !== null;

  async function respond(decision: "approve" | "deny", approval: OAuthApproval | null) {
    setPending(decision);
    setRequestError(null);
    try {
      const { redirectUrl } = await runApi(
        AuthApi.use((auth) =>
          approval === null
            ? auth.denyOAuthAuthorization(query)
            : auth.approveOAuthAuthorization(approval),
        ),
      );
      // Stay pending: the page is unloading.
      window.location.assign(redirectUrl);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "The request failed");
      setPending(null);
    }
  }

  function handleApprove(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (systemAdmin) {
      void respond("approve", {
        query,
        systemAdmin: true,
        tenantIds: [],
        scopes: [],
        resourceMode: "all",
        resourceGrants: [],
      });
      return;
    }

    const nextTenantError = chosenTenants.length === 0 ? "Select at least one tenant" : null;
    const nextScopeError = scopes.length === 0 ? "Select at least one scope" : null;
    const nextResourceError =
      resourceMode === "allowlist" && chosenResourceGrants.length === 0
        ? "Select at least one session or snapshot"
        : null;
    setTenantError(nextTenantError);
    setScopeError(nextScopeError);
    setResourceError(nextResourceError);
    if (nextTenantError !== null || nextScopeError !== null || nextResourceError !== null) {
      return;
    }

    void respond("approve", {
      query,
      systemAdmin: false,
      tenantIds: chosenTenants.map((tenant) => tenant.id),
      scopes,
      resourceMode,
      resourceGrants: resourceMode === "allowlist" ? chosenResourceGrants : [],
    });
  }

  function toggleTenant(tenantId: string, checked: boolean) {
    setTenantIds((current) =>
      checked ? [...current, tenantId] : current.filter((id) => id !== tenantId),
    );
    setTenantError(null);
  }

  function toggleScope(scope: TenantScope, checked: boolean) {
    setScopes((current) =>
      checked
        ? availableScopes.filter((item) => item === scope || current.includes(item))
        : current.filter((item) => item !== scope),
    );
    setScopeError(null);
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
            <ClientDetails request={request} />

            <div className="aperture:flex aperture:flex-wrap aperture:items-center aperture:gap-x-1 aperture:text-sm aperture:text-muted-foreground">
              <span>
                Signed in as{" "}
                <span className="aperture:font-medium aperture:text-foreground">
                  {request.user.displayName}
                </span>
                .
              </span>
              <SwitchAccountButton disabled={busy} />
            </div>

            {request.canGrantSystemAdmin ? (
              <Field orientation="horizontal" data-disabled={busy ? true : undefined}>
                <Checkbox
                  id="oauth-system-admin"
                  checked={systemAdmin}
                  onCheckedChange={(checked) => setSystemAdmin(checked)}
                  disabled={busy}
                />
                <FieldContent>
                  <FieldLabel htmlFor="oauth-system-admin">
                    Grant full system administrator access
                  </FieldLabel>
                  <FieldDescription>
                    The app can do anything you can as a system administrator, in every tenant.
                  </FieldDescription>
                </FieldContent>
              </Field>
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
                <TenantPicker
                  request={request}
                  allTenants={allTenants}
                  chosenTenantIds={chosenTenants.map((tenant) => tenant.id)}
                  scopes={scopes}
                  error={tenantError}
                  disabled={busy}
                  onAllTenantsChange={(checked) => {
                    setAllTenants(checked);
                    setTenantError(null);
                  }}
                  onToggleTenant={toggleTenant}
                />

                <FieldSet data-invalid={scopeError !== null ? true : undefined}>
                  <FieldLegend variant="label">Permissions</FieldLegend>
                  <FieldDescription>
                    Applied in every chosen tenant, limited to your own permissions there.
                  </FieldDescription>
                  <FieldGroup className="aperture:gap-3">
                    {availableScopes.map((scope) => (
                      <Field
                        key={scope}
                        orientation="horizontal"
                        data-disabled={busy ? true : undefined}
                      >
                        <Checkbox
                          id={`oauth-scope-${scope}`}
                          checked={scopes.includes(scope)}
                          onCheckedChange={(checked) => toggleScope(scope, checked)}
                          disabled={busy}
                        />
                        <FieldLabel htmlFor={`oauth-scope-${scope}`} className="aperture:gap-2">
                          {scopeLabel(scope)}
                          {request.requestedScopes.includes(scope) ? (
                            <Badge variant="outline" className="aperture:font-normal">
                              Requested
                            </Badge>
                          ) : null}
                        </FieldLabel>
                      </Field>
                    ))}
                  </FieldGroup>
                  <FieldError>{scopeError}</FieldError>
                </FieldSet>

                <Field data-invalid={resourceError !== null ? true : undefined}>
                  <FieldLabel>Resource access</FieldLabel>
                  <Select
                    items={RESOURCE_MODE_OPTIONS}
                    value={resourceMode}
                    onValueChange={(value) => {
                      if (value === "all" || value === "allowlist") {
                        setResourceMode(value);
                        setResourceError(null);
                      }
                    }}
                    disabled={busy}
                  >
                    <SelectTrigger className="aperture:w-full">
                      <SelectValue>
                        {(selectedValue: unknown) =>
                          RESOURCE_MODE_OPTIONS.find((option) => option.value === selectedValue)
                            ?.label ?? "All resources"
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {RESOURCE_MODE_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  {resourceMode === "allowlist" && chosenTenants.length === 0 ? (
                    <FieldDescription>Choose tenants to pick their resources.</FieldDescription>
                  ) : null}
                  <FieldError>{resourceError}</FieldError>
                </Field>

                {resourceMode === "allowlist"
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
                        onChange={(grants) => {
                          setResourceGrants((current) => ({ ...current, [tenant.id]: grants }));
                          setResourceError(null);
                        }}
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
            onClick={() => void respond("deny", null)}
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

function ClientDetails({ request }: { request: OAuthAuthorizationRequest }) {
  const { client } = request;

  return (
    <dl className="aperture:grid aperture:grid-cols-[auto_minmax(0,1fr)] aperture:gap-x-3 aperture:gap-y-1 aperture:text-sm">
      {client.uri !== null ? (
        <>
          <dt className="aperture:text-muted-foreground">Website</dt>
          <dd className="aperture:truncate">
            <a
              href={client.uri}
              target="_blank"
              rel="noopener noreferrer"
              className="aperture:underline aperture:underline-offset-4"
            >
              {client.uri}
            </a>
          </dd>
        </>
      ) : null}
      <dt className="aperture:text-muted-foreground">Client</dt>
      <dd className="aperture:truncate aperture:font-mono aperture:text-xs aperture:leading-5">
        {client.id}
      </dd>
      <dt className="aperture:text-muted-foreground">Redirects to</dt>
      <dd className="aperture:truncate aperture:font-mono aperture:text-xs aperture:leading-5">
        {request.redirectUri}
      </dd>
      {client.kind === "registered" ? (
        <dd className="aperture:col-span-2 aperture:text-xs aperture:text-muted-foreground">
          This app registered itself; its name and website are not verified.
        </dd>
      ) : null}
    </dl>
  );
}

interface TenantPickerProps {
  request: OAuthAuthorizationRequest;
  allTenants: boolean;
  chosenTenantIds: string[];
  scopes: TenantScope[];
  error: string | null;
  disabled: boolean;
  onAllTenantsChange: (checked: boolean) => void;
  onToggleTenant: (tenantId: string, checked: boolean) => void;
}

function TenantPicker({
  request,
  allTenants,
  chosenTenantIds,
  scopes,
  error,
  disabled,
  onAllTenantsChange,
  onToggleTenant,
}: TenantPickerProps) {
  if (request.tenants.length === 0) {
    return (
      <FieldSet>
        <FieldLegend variant="label">Tenants</FieldLegend>
        <FieldDescription>
          You are not a member of any tenant, so there is nothing to grant.
        </FieldDescription>
      </FieldSet>
    );
  }

  return (
    <FieldSet data-invalid={error !== null ? true : undefined}>
      <FieldLegend variant="label">Tenants</FieldLegend>
      <Field orientation="horizontal" data-disabled={disabled ? true : undefined}>
        <Checkbox
          id="oauth-all-tenants"
          checked={allTenants}
          onCheckedChange={(checked) => onAllTenantsChange(checked)}
          disabled={disabled}
        />
        <FieldContent>
          <FieldLabel htmlFor="oauth-all-tenants">All tenants</FieldLabel>
          <FieldDescription>
            Every tenant you can access now, but not ones you join later.
          </FieldDescription>
        </FieldContent>
      </Field>
      <FieldGroup className="aperture:gap-3">
        {request.tenants.map((tenant) => {
          const chosen = chosenTenantIds.includes(tenant.id);
          const effectiveScopes = scopes.filter((scope) => tenant.scopes.includes(scope));
          const inputId = `oauth-tenant-${tenant.id}`;

          return (
            <Field
              key={tenant.id}
              orientation="horizontal"
              data-disabled={disabled || allTenants ? true : undefined}
            >
              <Checkbox
                id={inputId}
                checked={chosen}
                onCheckedChange={(checked) => onToggleTenant(tenant.id, checked)}
                disabled={disabled || allTenants}
              />
              <FieldContent>
                <FieldLabel htmlFor={inputId}>{tenant.displayName}</FieldLabel>
                <div className="aperture:flex aperture:flex-wrap aperture:gap-1">
                  {tenant.scopes.map((scope) => (
                    <Badge
                      key={scope}
                      variant={chosen && scopes.includes(scope) ? "secondary" : "outline"}
                      className="aperture:font-normal"
                    >
                      {scopeLabel(scope)}
                    </Badge>
                  ))}
                </div>
                {chosen && scopes.length > 0 && effectiveScopes.length < scopes.length ? (
                  <FieldDescription>
                    {effectiveScopes.length === 0
                      ? "No access here: your membership has none of the selected permissions."
                      : `Not granted here: ${scopes
                          .filter((scope) => !tenant.scopes.includes(scope))
                          .map(scopeLabel)
                          .join(", ")}.`}
                  </FieldDescription>
                ) : null}
              </FieldContent>
            </Field>
          );
        })}
      </FieldGroup>
      <FieldError>{error}</FieldError>
    </FieldSet>
  );
}
