import { useEffect, useState } from "react";
import { CalendarClock, Check, ChevronsUpDown } from "lucide-react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
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
import { useCreateTokenMutation } from "#/hooks/mutations/use-tenant-token-mutations.ts";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { adminScopeOptions, tenantScopeOptions, type ScopeOption } from "#/lib/scopes.ts";
import { useFormDraftStore } from "#/stores/form-drafts.ts";

const AUTHORITY_OPTIONS = [
  { value: "tenant", label: "Tenant" },
  { value: "system_admin", label: "System admin" },
];

type CreateTokenDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function CreateTokenDialog({ open, onOpenChange }: CreateTokenDialogProps) {
  const credentials = useApiCredentials();
  const mutation = useCreateTokenMutation();
  const isAdmin = credentials?.authorityType === "system_admin";

  const draft = useFormDraftStore((state) => state.createToken);
  const setCreateToken = useFormDraftStore((state) => state.setCreateToken);
  const resetCreateToken = useFormDraftStore((state) => state.resetCreateToken);
  const toggleCreateTokenScope = useFormDraftStore((state) => state.toggleCreateTokenScope);
  const { name, authorityType, tenantId, scopes, expiresAt, nameError, scopeError, createdToken } =
    draft;

  const availableScopes = isAdmin ? adminScopeOptions : tenantScopeOptions;

  useEffect(() => {
    if (open) {
      resetCreateToken(credentials?.selectedTenantId ?? "");
    }
  }, [open, credentials?.selectedTenantId, resetCreateToken]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    const trimmedName = name.trim();
    if (!trimmedName) {
      setCreateToken({ nameError: "Name required" });
      return;
    }

    if (scopes.length === 0) {
      setCreateToken({ scopeError: "Select at least one scope" });
      return;
    }

    setCreateToken({ nameError: null, scopeError: null });

    const expiresAtValue = expiresAt ? new Date(expiresAt).toISOString() : null;

    const result = await mutation.mutateAsync(
      isAdmin
        ? {
            name: trimmedName,
            authorityType,
            tenantId: authorityType === "tenant" ? tenantId.trim() || null : null,
            scopes,
            expiresAt: expiresAtValue,
          }
        : {
            name: trimmedName,
            scopes,
            expiresAt: expiresAtValue,
          },
    );

    setCreateToken({ createdToken: result });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        {createdToken ? (
          <>
            <DialogHeader>
              <DialogTitle>Token created</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-3 py-2">
              <CopyField value={createdToken.rawToken} />
            </div>
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)}>
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
                  onChange={(event) =>
                    setCreateToken({ name: event.target.value, nameError: null })
                  }
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
                          setCreateToken({ authorityType: value });
                        }
                      }}
                      disabled={mutation.isPending}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Authority">
                          {(selectedValue: unknown) =>
                            AUTHORITY_OPTIONS.find((option) => option.value === selectedValue)
                              ?.label ?? "Authority"
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
                        onSelect={(tenant) => setCreateToken({ tenantId: tenant.id })}
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
                    toggleCreateTokenScope(scope);
                    setCreateToken({ scopeError: null });
                  }}
                />
                <FieldError>{scopeError}</FieldError>
              </Field>
              <Field>
                <FieldLabel htmlFor="token-expires">Expires at</FieldLabel>
                <ExpiresAtControl
                  id="token-expires"
                  value={expiresAt}
                  disabled={mutation.isPending}
                  onChange={(nextValue) => setCreateToken({ expiresAt: nextValue })}
                />
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={mutation.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={mutation.isPending}>
                Create
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
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
