import { Button } from "@aperture-browser/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@aperture-browser/ui/components/dropdown-menu";
import { ListFilter } from "lucide-react";
import { Fragment } from "react";
import { Choice } from "#/components/choice.tsx";

/** One thing a list is narrowed or ordered by: its first option is how the list is by itself. */
export interface Filter<Value extends string = string> {
  readonly label: string;
  readonly value: Value;
  readonly options: ReadonlyArray<{ readonly value: Value; readonly label: string }>;
  readonly onChange: (value: Value) => void;
}

/** Keeps a filter's own kind of value while it stands among filters of other kinds. */
export const filter = <Value extends string>(one: Filter<Value>): Filter =>
  one as unknown as Filter;

/**
 * What a page's list is narrowed and ordered by, in its title bar: a select each where
 * there is room, and one menu of them all on a phone.
 */
export function Filters({ filters }: { filters: ReadonlyArray<Filter> }) {
  const changed = filters.some((one) => one.value !== one.options[0]?.value);
  return (
    <>
      {filters.map((one) => (
        <Choice
          key={one.label}
          size="sm"
          aria-label={one.label}
          value={one.value}
          options={one.options}
          onChange={one.onChange}
          className="aperture:max-sm:hidden"
        />
      ))}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              size="icon-sm"
              variant={changed ? "secondary" : "ghost"}
              aria-label="Filter"
              data-console-filters
              className="aperture:sm:hidden"
            />
          }
        >
          <ListFilter />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="aperture:w-auto aperture:min-w-48">
          {filters.map((one, index) => (
            <Fragment key={one.label}>
              {index > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuGroup>
                <DropdownMenuLabel>{one.label}</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={one.value} onValueChange={one.onChange}>
                  {one.options.map((option) => (
                    <DropdownMenuRadioItem
                      key={option.value}
                      value={option.value}
                      closeOnClick={filters.length === 1}
                    >
                      {option.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            </Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
