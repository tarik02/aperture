import { useMemo, useState } from "react";
import { Building2, Check, ChevronsUpDown, Loader2, Search } from "lucide-react";
import { Button } from "@aperture-browser/ui/components/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@aperture-browser/ui/components/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "@aperture-browser/ui/components/popover";
import { ScrollArea } from "@aperture-browser/ui/components/scroll-area";
import { useTenantsInfiniteQuery } from "#/features/tenant/tenant.queries.ts";
import { flattenInfinitePages } from "@aperture-browser/api-client";
import type { Tenant } from "@aperture-browser/api-client";
import { cn } from "@aperture-browser/ui/utils";

interface TenantComboboxProps {
  value: string | null;
  selectedLabel?: string | null;
  onSelect: (tenant: Tenant) => void;
  disabled?: boolean;
  placeholder?: string;
  triggerClassName?: string;
  align?: "start" | "center" | "end";
  options?: readonly Tenant[];
}

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
            className={cn(
              "aperture:w-56 aperture:min-w-0 aperture:justify-start",
              triggerClassName,
            )}
            disabled={disabled}
          />
        }
      >
        <Building2 data-icon="inline-start" />
        <span
          data-sidebar-collapse-label
          className="aperture:min-w-0 aperture:flex-1 aperture:truncate aperture:text-left"
        >
          {label}
        </span>
        <ChevronsUpDown data-icon="inline-end" data-sidebar-collapse-label />
      </PopoverTrigger>
      <PopoverContent
        align={align}
        className="aperture:w-80 aperture:max-w-[calc(100vw-1rem)] aperture:gap-2 aperture:p-2"
      >
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
        <ScrollArea className="aperture:max-h-64">
          <div className="aperture:flex aperture:flex-col aperture:gap-1 aperture:pr-2">
            {!options && query.isLoading ? (
              <div className="aperture:flex aperture:items-center aperture:gap-2 aperture:px-2 aperture:py-3 aperture:text-sm aperture:text-muted-foreground aperture:[&_svg:not([class*='size-'])]:size-4">
                <Loader2 className="aperture:animate-spin" />
                Loading tenants
              </div>
            ) : filteredTenants.length === 0 ? (
              <div className="aperture:px-2 aperture:py-3 aperture:text-sm aperture:text-muted-foreground">
                No tenants found
              </div>
            ) : (
              filteredTenants.map((tenant) => (
                <button
                  key={tenant.id}
                  type="button"
                  className={cn(
                    "aperture:flex aperture:w-full aperture:items-center aperture:gap-2 aperture:rounded-md aperture:px-2 aperture:py-1.5 aperture:text-left aperture:text-sm aperture:outline-none aperture:hover:bg-accent aperture:hover:text-accent-foreground aperture:focus:bg-accent aperture:focus:text-accent-foreground aperture:[&_svg:not([class*='size-'])]:size-4",
                    value === tenant.id && "aperture:bg-accent aperture:text-accent-foreground",
                  )}
                  onClick={() => {
                    onSelect(tenant);
                    setSearch("");
                    setOpen(false);
                  }}
                >
                  <span className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:flex-col aperture:gap-0.5">
                    <span className="aperture:truncate aperture:font-medium">
                      {tenant.displayName}
                    </span>
                    <span className="aperture:truncate aperture:font-mono aperture:text-xs aperture:text-muted-foreground">
                      {tenant.id}
                    </span>
                  </span>
                  {value === tenant.id ? <Check className="aperture:shrink-0" /> : null}
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
            className="aperture:w-full"
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
