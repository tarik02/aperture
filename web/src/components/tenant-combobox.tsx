import { useMemo, useState } from "react";
import { Building2, Check, ChevronsUpDown, Loader2, Search } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { InputGroup, InputGroupAddon, InputGroupInput } from "#/components/ui/input-group.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "#/components/ui/popover.tsx";
import { ScrollArea } from "#/components/ui/scroll-area.tsx";
import { useTenantsInfiniteQuery } from "#/features/tenant/tenant.queries.ts";
import { flattenInfinitePages } from "#/lib/api/pagination.ts";
import type { Tenant } from "#/lib/api/schemas.ts";
import { cn } from "#/lib/utils.ts";

type TenantComboboxProps = {
  value: string | null;
  selectedLabel?: string | null;
  onSelect: (tenant: Tenant) => void;
  disabled?: boolean;
  placeholder?: string;
  triggerClassName?: string;
  align?: "start" | "center" | "end";
  options?: Tenant[];
};

export function TenantCombobox({
  value,
  selectedLabel = null,
  onSelect,
  disabled,
  placeholder = "Select tenant",
  triggerClassName,
  align = "end",
  options,
}: TenantComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const query = useTenantsInfiniteQuery({ limit: 100 });

  const tenants = useMemo(
    () => options ?? flattenInfinitePages(query.data?.pages),
    [options, query.data?.pages],
  );
  const selectedTenant = useMemo(
    () => tenants.find((tenant) => tenant.id === value) ?? null,
    [tenants, value],
  );
  const normalizedSearch = search.trim().toLowerCase();
  const filteredTenants = useMemo(() => {
    if (!normalizedSearch) {
      return tenants;
    }
    return tenants.filter(
      (tenant) =>
        tenant.displayName.toLowerCase().includes(normalizedSearch) ||
        tenant.id.toLowerCase().includes(normalizedSearch),
    );
  }, [tenants, normalizedSearch]);

  const label = selectedLabel ?? selectedTenant?.displayName ?? value ?? placeholder;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn("w-56 min-w-0 justify-start", triggerClassName)}
            disabled={disabled}
          />
        }
      >
        <Building2 data-icon="inline-start" />
        <span data-sidebar-collapse-label className="min-w-0 flex-1 truncate text-left">
          {label}
        </span>
        <ChevronsUpDown data-icon="inline-end" data-sidebar-collapse-label />
      </PopoverTrigger>
      <PopoverContent align={align} className="w-80 max-w-[calc(100vw-1rem)] gap-2 p-2">
        <InputGroup>
          <InputGroupInput
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search tenants"
            autoFocus
          />
          <InputGroupAddon align="inline-start">
            <Search />
          </InputGroupAddon>
        </InputGroup>
        <ScrollArea className="max-h-64">
          <div className="flex flex-col gap-1 pr-2">
            {!options && query.isLoading ? (
              <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground [&_svg:not([class*='size-'])]:size-4">
                <Loader2 className="animate-spin" />
                Loading tenants
              </div>
            ) : filteredTenants.length === 0 ? (
              <div className="px-2 py-3 text-sm text-muted-foreground">No tenants found</div>
            ) : (
              filteredTenants.map((tenant) => (
                <button
                  key={tenant.id}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground [&_svg:not([class*='size-'])]:size-4",
                    value === tenant.id && "bg-accent text-accent-foreground",
                  )}
                  onClick={() => {
                    onSelect(tenant);
                    setSearch("");
                    setOpen(false);
                  }}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate font-medium">{tenant.displayName}</span>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {tenant.id}
                    </span>
                  </span>
                  {value === tenant.id ? <Check className="shrink-0" /> : null}
                </button>
              ))
            )}
          </div>
        </ScrollArea>
        {!options && query.hasNextPage ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            {query.isFetchingNextPage ? "Loading..." : "Load more"}
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
