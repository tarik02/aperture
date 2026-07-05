export type ScopeOption = {
  value: string;
  label: string;
};

export const tenantScopeOptions = [
  { value: "sessions:read", label: "Sessions read" },
  { value: "sessions:write", label: "Sessions write" },
  { value: "snapshots:read", label: "Snapshots read" },
  { value: "snapshots:write", label: "Snapshots write" },
  { value: "tenant:write", label: "Tenant manage" },
] satisfies ScopeOption[];

export const adminScopeOptions = [
  { value: "system:admin", label: "System admin" },
  ...tenantScopeOptions,
  { value: "tenants:write", label: "Tenants manage" },
] satisfies ScopeOption[];

export const scopePriority = [
  "system:admin",
  "sessions:write",
  "snapshots:write",
  "tenant:write",
  "tenants:write",
  "sessions:read",
  "snapshots:read",
];

export function scopeLabel(scope: string): string {
  return adminScopeOptions.find((option) => option.value === scope)?.label ?? scope;
}
