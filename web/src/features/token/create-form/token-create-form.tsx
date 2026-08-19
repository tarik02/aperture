import { useEffect, useMemo, useState } from "react";
import { CalendarClock, Check, ChevronsUpDown } from "lucide-react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "#/components/ui/combobox.tsx";
import { DialogFooter, DialogHeader, DialogTitle } from "#/components/ui/dialog.tsx";
import { Field, FieldError, FieldGroup, FieldLabel } from "#/components/ui/field.tsx";
import { InputGroup, InputGroupAddon, InputGroupInput } from "#/components/ui/input-group.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "#/components/ui/popover.tsx";
import { ScrollArea } from "#/components/ui/scroll-area.tsx";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select.tsx";
import { CopyField } from "#/components/resources/copy-field.tsx";
import { TenantCombobox } from "#/components/tenant-combobox.tsx";
import { useSessionsInfiniteQuery } from "#/features/session/session.queries.ts";
import { useSnapshotsInfiniteQuery } from "#/features/snapshot/snapshot.queries.ts";
import { useCreateTokenMutation } from "#/features/token/token.mutations.ts";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import type { ApiCredentials } from "#/lib/api/client.ts";
import { flattenInfinitePages } from "#/lib/api/pagination.ts";
import { adminScopeOptions, tenantScopeOptions, type ScopeOption } from "#/lib/scopes.ts";
import { useTokenCreateFormStore } from "#/features/token/create-form/token-create-form.store.ts";
import { useTokenCreateModalStore } from "#/features/token/create-modal/token-create-modal.store.ts";
import type { ResourceGrant } from "#/lib/api/schemas.ts";

const AUTHORITY_OPTIONS = [
  { value: "tenant", label: "Tenant" },
  { value: "system_admin", label: "System admin" },
];

const RESOURCE_MODE_OPTIONS = [
  { value: "all", label: "All resources" },
  { value: "allowlist", label: "Allowlist" },
];

export function TokenCreateForm() {
  const credentials = useApiCredentials();
  const mutation = useCreateTokenMutation();
  const isAdmin = credentials?.authorityType === "system_admin";

  const draft = useTokenCreateFormStore((state) => state.formData);
  const setFormData = useTokenCreateFormStore((state) => state.setFormData);
  const toggleScope = useTokenCreateFormStore((state) => state.toggleScope);
  const closeModal = useTokenCreateModalStore((state) => state.closeModal);
  const {
    name,
    authorityType,
    tenantId,
    scopes,
    resourceMode,
    resourceGrants,
    expiresAt,
    nameError,
    scopeError,
    createdToken,
  } = draft;

  const availableScopes = isAdmin ? adminScopeOptions : tenantScopeOptions;
  const resourceRestrictedByParent = credentials?.resourceMode === "allowlist";
  const effectiveResourceMode = isAdmin && authorityType === "system_admin" ? "all" : resourceMode;
  const resourceTenantId = isAdmin
    ? tenantId.trim() || null
    : (credentials?.tenantId ?? credentials?.selectedTenantId ?? null);
  const resourceCredentials = useMemo<ApiCredentials | null>(() => {
    if (!credentials || !resourceTenantId) {
      return null;
    }
    return { ...credentials, selectedTenantId: resourceTenantId };
  }, [credentials, resourceTenantId]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormData({ nameError: "Name required" });
      return;
    }

    if (scopes.length === 0) {
      setFormData({ scopeError: "Select at least one scope" });
      return;
    }

    const submittedResourceGrants = effectiveResourceMode === "allowlist" ? resourceGrants : [];

    setFormData({ nameError: null, scopeError: null });

    const expiresAtValue = expiresAt ? new Date(expiresAt).toISOString() : null;

    const result = await mutation.mutateAsync(
      isAdmin
        ? {
            kind: "admin",
            input: {
              name: trimmedName,
              authorityType,
              tenantId: authorityType === "tenant" ? tenantId.trim() || null : null,
              scopes,
              resourceMode: effectiveResourceMode,
              resourceGrants: submittedResourceGrants,
              expiresAt: expiresAtValue,
            },
          }
        : {
            kind: "tenant",
            input: {
              name: trimmedName,
              scopes,
              resourceMode: effectiveResourceMode,
              resourceGrants: submittedResourceGrants,
              expiresAt: expiresAtValue,
            },
          },
    );

    setFormData({ createdToken: result });
  }

  return createdToken ? (
    <>
      <DialogHeader>
        <DialogTitle>Token created</DialogTitle>
      </DialogHeader>
      <div className="flex flex-col gap-3 py-2">
        <CopyField value={createdToken.rawToken} />
      </div>
      <DialogFooter>
        <Button type="button" onClick={closeModal}>
          Done
        </Button>
      </DialogFooter>
    </>
  ) : (
    <form onSubmit={(event) => void handleSubmit(event)}>
      <DialogHeader>
        <DialogTitle>Create token</DialogTitle>
      </DialogHeader>
      <FieldGroup className="py-2">
        <Field data-invalid={nameError ? true : undefined}>
          <FieldLabel htmlFor="token-name">Name</FieldLabel>
          <Input
            id="token-name"
            value={name}
            onChange={(event) => setFormData({ name: event.target.value, nameError: null })}
            disabled={mutation.isPending}
          />
          <FieldError>{nameError}</FieldError>
        </Field>
        {isAdmin ? (
          <>
            <Field>
              <FieldLabel>Authority</FieldLabel>
              <Select
                items={AUTHORITY_OPTIONS}
                value={authorityType}
                onValueChange={(value) => {
                  if (value === "system_admin" || value === "tenant") {
                    setFormData({
                      authorityType: value,
                      ...(value === "system_admin"
                        ? { resourceMode: "all", resourceGrants: [] }
                        : {}),
                    });
                  }
                }}
                disabled={mutation.isPending}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Authority">
                    {(selectedValue: unknown) =>
                      AUTHORITY_OPTIONS.find((option) => option.value === selectedValue)?.label ??
                      "Authority"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="tenant">Tenant</SelectItem>
                    <SelectItem value="system_admin">System admin</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            {authorityType === "tenant" ? (
              <Field>
                <FieldLabel>Tenant</FieldLabel>
                <TenantCombobox
                  value={tenantId || null}
                  onSelect={(tenant) => setFormData({ tenantId: tenant.id, resourceGrants: [] })}
                  disabled={mutation.isPending}
                  align="start"
                  triggerClassName="w-full"
                />
              </Field>
            ) : null}
          </>
        ) : null}
        <Field data-invalid={scopeError ? true : undefined}>
          <FieldLabel>Scopes</FieldLabel>
          <ScopeMultiSelect
            options={availableScopes}
            value={scopes}
            invalid={scopeError ? true : undefined}
            disabled={mutation.isPending}
            onToggle={(scope) => {
              toggleScope(scope);
              setFormData({ scopeError: null });
            }}
          />
          <FieldError>{scopeError}</FieldError>
        </Field>
        <Field>
          <FieldLabel>Resource access</FieldLabel>
          <Select
            items={RESOURCE_MODE_OPTIONS.filter(
              (option) => !resourceRestrictedByParent || option.value === "allowlist",
            )}
            value={effectiveResourceMode}
            onValueChange={(value) => {
              if (value === "all" || value === "allowlist") {
                setFormData({ resourceMode: value });
              }
            }}
            disabled={
              mutation.isPending ||
              resourceRestrictedByParent ||
              (isAdmin && authorityType === "system_admin")
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue>
                {(selectedValue: unknown) =>
                  RESOURCE_MODE_OPTIONS.find((option) => option.value === selectedValue)?.label ??
                  "All resources"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {RESOURCE_MODE_OPTIONS.filter(
                  (option) => !resourceRestrictedByParent || option.value === "allowlist",
                ).map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        {effectiveResourceMode === "allowlist" ? (
          <ResourceGrantEditor
            grants={resourceGrants}
            credentials={resourceCredentials}
            disabled={mutation.isPending}
            onChange={(nextGrants) => setFormData({ resourceGrants: nextGrants })}
          />
        ) : null}
        <Field>
          <FieldLabel htmlFor="token-expires">Expires at</FieldLabel>
          <ExpiresAtControl
            id="token-expires"
            value={expiresAt}
            disabled={mutation.isPending}
            onChange={(nextValue) => setFormData({ expiresAt: nextValue })}
          />
        </Field>
      </FieldGroup>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={closeModal} disabled={mutation.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={mutation.isPending}>
          Create
        </Button>
      </DialogFooter>
    </form>
  );
}

type ResourceGrantEditorProps = {
  grants: ResourceGrant[];
  credentials: ApiCredentials | null;
  disabled?: boolean;
  onChange: (grants: ResourceGrant[]) => void;
};

type ResourceOption = {
  value: string;
  label: string;
  detail: string;
  resourceType: "session" | "snapshot";
  resourceId: string;
};

type ResourceOptionGroup = {
  value: string;
  items: ResourceOption[];
};

function ResourceGrantEditor({
  grants,
  credentials,
  disabled,
  onChange,
}: ResourceGrantEditorProps) {
  const anchor = useComboboxAnchor();
  const sessionsQuery = useSessionsInfiniteQuery(
    { limit: 100 },
    { credentials, enabled: credentials !== null },
  );
  const snapshotsQuery = useSnapshotsInfiniteQuery(
    { limit: 100 },
    { credentials, enabled: credentials !== null },
  );
  const sessions = useMemo(
    () => flattenInfinitePages(sessionsQuery.data?.pages),
    [sessionsQuery.data?.pages],
  );
  const snapshots = useMemo(
    () => flattenInfinitePages(snapshotsQuery.data?.pages),
    [snapshotsQuery.data?.pages],
  );
  const groups = useMemo<ResourceOptionGroup[]>(
    () => [
      {
        value: "Sessions",
        items: sessions.map((session) => ({
          value: `session:${session.id}`,
          label: session.label?.trim() || "Untitled session",
          detail: `${session.status} · ${session.id}`,
          resourceType: "session",
          resourceId: session.id,
        })),
      },
      {
        value: "Snapshots",
        items: snapshots.map((snapshot) => ({
          value: `snapshot:${snapshot.id}`,
          label: snapshot.name,
          detail: snapshot.id,
          resourceType: "snapshot",
          resourceId: snapshot.id,
        })),
      },
    ],
    [sessions, snapshots],
  );
  const options = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const selectedOptions = useMemo(
    () =>
      grants.map(
        (grant) =>
          options.find(
            (option) =>
              option.resourceType === grant.resourceType && option.resourceId === grant.resourceId,
          ) ?? {
            value: `${grant.resourceType}:${grant.resourceId}`,
            label: grant.resourceId,
            detail: grant.resourceId,
            resourceType: grant.resourceType,
            resourceId: grant.resourceId,
          },
      ),
    [grants, options],
  );
  const loading = sessionsQuery.isLoading || snapshotsQuery.isLoading;
  const failed = sessionsQuery.isError || snapshotsQuery.isError;
  const loadingMore = sessionsQuery.isFetchingNextPage || snapshotsQuery.isFetchingNextPage;
  const hasMore = sessionsQuery.hasNextPage || snapshotsQuery.hasNextPage;

  return (
    <Field data-disabled={disabled || credentials === null ? true : undefined}>
      <FieldLabel htmlFor="token-resource-grants">Resource grants</FieldLabel>
      <Combobox
        multiple
        autoHighlight
        items={groups}
        value={selectedOptions}
        itemToStringLabel={(option: ResourceOption) => `${option.label} ${option.resourceId}`}
        itemToStringValue={(option: ResourceOption) => option.value}
        isItemEqualToValue={(option: ResourceOption, value: ResourceOption) =>
          option.value === value.value
        }
        filter={(option: ResourceOption, query: string) => {
          const normalizedQuery = query.trim().toLowerCase();
          return (
            option.label.toLowerCase().includes(normalizedQuery) ||
            option.resourceId.toLowerCase().includes(normalizedQuery)
          );
        }}
        onValueChange={(nextOptions: ResourceOption[]) =>
          onChange(
            nextOptions.map((option) => ({
              resourceType: option.resourceType,
              resourceId: option.resourceId,
            })),
          )
        }
        disabled={disabled || credentials === null}
      >
        <ComboboxChips ref={anchor}>
          <ComboboxValue>
            {(values) => (
              <>
                {values.map((option: ResourceOption) => (
                  <ComboboxChip key={option.value}>
                    <span className="max-w-48 truncate">
                      {option.resourceType === "session" ? "Session" : "Snapshot"}: {option.label}
                    </span>
                  </ComboboxChip>
                ))}
                <ComboboxChipsInput
                  id="token-resource-grants"
                  placeholder={values.length === 0 ? "Search sessions and snapshots" : undefined}
                  disabled={disabled || credentials === null}
                />
              </>
            )}
          </ComboboxValue>
        </ComboboxChips>
        <ComboboxContent anchor={anchor}>
          <ComboboxEmpty>
            {credentials === null
              ? "Select a tenant first"
              : loading
                ? "Loading resources..."
                : failed
                  ? "Failed to load resources"
                  : "No resources found"}
          </ComboboxEmpty>
          <ComboboxList>
            {(group: ResourceOptionGroup) => (
              <ComboboxGroup key={group.value} items={group.items}>
                <ComboboxLabel>{group.value}</ComboboxLabel>
                <ComboboxCollection>
                  {(option: ResourceOption) => (
                    <ComboboxItem key={option.value} value={option}>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate">{option.label}</span>
                        <span className="truncate font-mono text-xs text-muted-foreground">
                          {option.detail}
                        </span>
                      </span>
                    </ComboboxItem>
                  )}
                </ComboboxCollection>
              </ComboboxGroup>
            )}
          </ComboboxList>
          {hasMore ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="m-1 w-[calc(100%-0.5rem)]"
              onClick={() => {
                if (sessionsQuery.hasNextPage) {
                  void sessionsQuery.fetchNextPage();
                }
                if (snapshotsQuery.hasNextPage) {
                  void snapshotsQuery.fetchNextPage();
                }
              }}
              disabled={loadingMore}
            >
              {loadingMore ? "Loading..." : "Load more resources"}
            </Button>
          ) : null}
        </ComboboxContent>
      </Combobox>
    </Field>
  );
}

type ScopeMultiSelectProps = {
  options: ScopeOption[];
  value: string[];
  invalid?: boolean;
  disabled?: boolean;
  onToggle: (scope: string) => void;
};

function ScopeMultiSelect({ options, value, invalid, disabled, onToggle }: ScopeMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const selectedOptions = options.filter((option) => value.includes(option.value));
  const firstSelected = selectedOptions[0] ?? null;
  const hiddenCount = Math.max(selectedOptions.length - 1, 0);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full justify-between"
            aria-invalid={invalid}
            disabled={disabled}
          />
        }
      >
        <span className="flex min-w-0 flex-1 items-center gap-1">
          {firstSelected ? (
            <Badge variant="secondary" className="max-w-48 truncate font-normal">
              {firstSelected.label}
            </Badge>
          ) : (
            <span className="min-w-0 truncate text-muted-foreground">Select scopes</span>
          )}
          {hiddenCount > 0 ? (
            <Badge variant="outline" className="font-normal">
              +{hiddenCount}
            </Badge>
          ) : null}
        </span>
        <ChevronsUpDown data-icon="inline-end" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-1rem)] p-2">
        <ScrollArea className="h-64">
          <div className="flex flex-col gap-1">
            {options.map((option) => {
              const selected = value.includes(option.value);

              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={selected}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground [&_svg:not([class*='size-'])]:size-4"
                  onClick={() => onToggle(option.value)}
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {selected ? <Check className="shrink-0" /> : null}
                </button>
              );
            })}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

const expiresAtOptions = [
  { value: "never", label: "Never" },
  { value: "1d", label: "1 day" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "custom", label: "Custom" },
];

type ExpiresAtPreset = "never" | "1d" | "7d" | "30d" | "custom";

type ExpiresAtControlProps = {
  id: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
};

function ExpiresAtControl({ id, value, disabled, onChange }: ExpiresAtControlProps) {
  const [preset, setPreset] = useState<ExpiresAtPreset>(value ? "custom" : "never");

  useEffect(() => {
    if (!value) {
      setPreset("never");
    }
  }, [value]);

  function handlePresetChange(nextValue: unknown) {
    const nextPreset = resolveExpiresAtPreset(nextValue);
    if (!nextPreset) {
      return;
    }

    setPreset(nextPreset);
    switch (nextPreset) {
      case "never":
        onChange("");
        return;
      case "1d":
        onChange(toDatetimeLocalValue(addDays(1)));
        return;
      case "7d":
        onChange(toDatetimeLocalValue(addDays(7)));
        return;
      case "30d":
        onChange(toDatetimeLocalValue(addDays(30)));
        return;
      case "custom":
        return;
      default: {
        const exhaustive: never = nextPreset;
        return exhaustive;
      }
    }
  }

  function handleDateChange(nextValue: string) {
    setPreset(nextValue ? "custom" : "never");
    onChange(nextValue);
  }

  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <Select items={expiresAtOptions} value={preset} onValueChange={handlePresetChange}>
        <SelectTrigger size="sm" className="w-full sm:w-32">
          <SelectValue>
            {(selectedValue: unknown) =>
              expiresAtOptions.find((option) => option.value === selectedValue)?.label ?? "Never"
            }
          </SelectValue>
        </SelectTrigger>
        <SelectContent align="start">
          <SelectGroup>
            {expiresAtOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {preset === "custom" ? (
        <InputGroup className="flex-1">
          <InputGroupInput
            id={id}
            type="datetime-local"
            value={value}
            disabled={disabled}
            onChange={(event) => handleDateChange(event.target.value)}
          />
          <InputGroupAddon align="inline-start">
            <CalendarClock />
          </InputGroupAddon>
        </InputGroup>
      ) : null}
    </div>
  );
}

function resolveExpiresAtPreset(value: unknown): ExpiresAtPreset | null {
  switch (value) {
    case "never":
    case "1d":
    case "7d":
    case "30d":
    case "custom":
      return value;
    default:
      return null;
  }
}

function addDays(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
}

function toDatetimeLocalValue(date: Date): string {
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localDate.toISOString().slice(0, 16);
}
