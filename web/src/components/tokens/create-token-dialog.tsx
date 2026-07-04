import { useEffect, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import { Field, FieldError, FieldGroup, FieldLabel } from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Checkbox } from "#/components/ui/checkbox.tsx";
import { Label } from "#/components/ui/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select.tsx";
import { CopyField } from "#/components/resources/copy-field.tsx";
import { useCreateTokenMutation } from "#/hooks/mutations/use-tenant-token-mutations.ts";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import type { CreateTokenResponse } from "#/lib/api/schemas.ts";

const TENANT_SCOPES = [
  "sessions:read",
  "sessions:write",
  "snapshots:read",
  "snapshots:write",
  "tenant:write",
] as const;

const ADMIN_SCOPES = ["system:admin", ...TENANT_SCOPES, "tenants:write"] as const;

type CreateTokenDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function CreateTokenDialog({ open, onOpenChange }: CreateTokenDialogProps) {
  const credentials = useApiCredentials();
  const mutation = useCreateTokenMutation();
  const isAdmin = credentials?.authorityType === "system_admin";

  const [name, setName] = useState("");
  const [authorityType, setAuthorityType] = useState<"system_admin" | "tenant">("tenant");
  const [tenantId, setTenantId] = useState("");
  const [scopes, setScopes] = useState<string[]>(["sessions:read", "sessions:write"]);
  const [expiresAt, setExpiresAt] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [createdToken, setCreatedToken] = useState<CreateTokenResponse | null>(null);

  const availableScopes = isAdmin ? ADMIN_SCOPES : TENANT_SCOPES;

  useEffect(() => {
    if (!open) {
      setName("");
      setAuthorityType("tenant");
      setTenantId(credentials?.selectedTenantId ?? "");
      setScopes(["sessions:read", "sessions:write"]);
      setExpiresAt("");
      setNameError(null);
      setCreatedToken(null);
    }
  }, [open, credentials?.selectedTenantId]);

  function toggleScope(scope: string) {
    setScopes((current) =>
      current.includes(scope) ? current.filter((item) => item !== scope) : [...current, scope],
    );
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError("Name required");
      return;
    }

    if (scopes.length === 0) {
      setNameError("Select at least one scope");
      return;
    }

    setNameError(null);

    const result = await mutation.mutateAsync(
      isAdmin
        ? {
            name: trimmedName,
            authorityType,
            tenantId: authorityType === "tenant" ? tenantId.trim() || null : null,
            scopes,
            expiresAt: expiresAt.trim() || null,
          }
        : {
            name: trimmedName,
            scopes,
            expiresAt: expiresAt.trim() || null,
          },
    );

    setCreatedToken(result);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {createdToken ? (
          <>
            <DialogHeader>
              <DialogTitle>Token created</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-2">
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
                  onChange={(event) => setName(event.target.value)}
                  disabled={mutation.isPending}
                />
                <FieldError>{nameError}</FieldError>
              </Field>
              {isAdmin ? (
                <>
                  <Field>
                    <FieldLabel>Authority</FieldLabel>
                    <Select
                      value={authorityType}
                      onValueChange={(value) =>
                        setAuthorityType((value as "system_admin" | "tenant") ?? "tenant")
                      }
                      disabled={mutation.isPending}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="tenant">tenant</SelectItem>
                        <SelectItem value="system_admin">system_admin</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  {authorityType === "tenant" ? (
                    <Field>
                      <FieldLabel htmlFor="token-tenant-id">Tenant ID</FieldLabel>
                      <Input
                        id="token-tenant-id"
                        value={tenantId}
                        onChange={(event) => setTenantId(event.target.value)}
                        disabled={mutation.isPending}
                      />
                    </Field>
                  ) : null}
                </>
              ) : null}
              <Field>
                <FieldLabel>Scopes</FieldLabel>
                <div className="grid gap-2">
                  {availableScopes.map((scope) => (
                    <div key={scope} className="flex items-center gap-2">
                      <Checkbox
                        id={`scope-${scope}`}
                        checked={scopes.includes(scope)}
                        onCheckedChange={() => toggleScope(scope)}
                        disabled={mutation.isPending}
                      />
                      <Label htmlFor={`scope-${scope}`} className="font-mono text-xs">
                        {scope}
                      </Label>
                    </div>
                  ))}
                </div>
              </Field>
              <Field>
                <FieldLabel htmlFor="token-expires">Expires</FieldLabel>
                <Input
                  id="token-expires"
                  value={expiresAt}
                  onChange={(event) => setExpiresAt(event.target.value)}
                  placeholder="RFC3339"
                  disabled={mutation.isPending}
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
