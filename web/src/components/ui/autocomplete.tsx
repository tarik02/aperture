"use client";

import { Autocomplete as AutocompletePrimitive } from "@base-ui/react";
import { ChevronDownIcon, XIcon } from "lucide-react";

import { cn } from "#/lib/utils.ts";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "#/components/ui/input-group.tsx";

const Autocomplete = AutocompletePrimitive.Root;

function AutocompleteValue({ ...props }: AutocompletePrimitive.Value.Props) {
  return <AutocompletePrimitive.Value data-slot="autocomplete-value" {...props} />;
}

function AutocompleteTrigger({
  className,
  children,
  ...props
}: AutocompletePrimitive.Trigger.Props) {
  return (
    <AutocompletePrimitive.Trigger
      data-slot="autocomplete-trigger"
      className={cn("[&_svg:not([class*='size-'])]:size-4", className)}
      {...props}
    >
      {children}
      <ChevronDownIcon className="pointer-events-none size-4 text-muted-foreground" />
    </AutocompletePrimitive.Trigger>
  );
}

function AutocompleteClear({ className, ...props }: AutocompletePrimitive.Clear.Props) {
  return (
    <AutocompletePrimitive.Clear
      data-slot="autocomplete-clear"
      render={<InputGroupButton variant="ghost" size="icon-xs" />}
      className={cn(className)}
      {...props}
    >
      <XIcon className="pointer-events-none" />
    </AutocompletePrimitive.Clear>
  );
}

function AutocompleteInput({
  className,
  disabled = false,
  showClear = false,
  ...props
}: AutocompletePrimitive.Input.Props & {
  showClear?: boolean;
}) {
  return (
    <InputGroup className={cn("w-auto", className)}>
      <AutocompletePrimitive.Input render={<InputGroupInput disabled={disabled} />} {...props} />
      {showClear ? (
        <InputGroupAddon align="inline-end">
          <AutocompleteClear disabled={disabled} />
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  );
}

function AutocompleteContent({
  className,
  side = "bottom",
  sideOffset = 6,
  align = "start",
  alignOffset = 0,
  anchor,
  ...props
}: AutocompletePrimitive.Popup.Props &
  Pick<
    AutocompletePrimitive.Positioner.Props,
    "side" | "align" | "sideOffset" | "alignOffset" | "anchor"
  >) {
  return (
    <AutocompletePrimitive.Portal>
      <AutocompletePrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        className="isolate z-50"
      >
        <AutocompletePrimitive.Popup
          data-slot="autocomplete-content"
          className={cn(
            "relative max-h-(--available-height) w-(--anchor-width) max-w-(--available-width) origin-(--transform-origin) overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 *:data-[slot=input-group]:m-1 *:data-[slot=input-group]:mb-0 *:data-[slot=input-group]:h-8 *:data-[slot=input-group]:border-input/30 *:data-[slot=input-group]:bg-input/30 *:data-[slot=input-group]:shadow-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
        />
      </AutocompletePrimitive.Positioner>
    </AutocompletePrimitive.Portal>
  );
}

function AutocompleteList({ className, ...props }: AutocompletePrimitive.List.Props) {
  return (
    <AutocompletePrimitive.List
      data-slot="autocomplete-list"
      className={cn(
        "no-scrollbar max-h-[min(calc(--spacing(72)---spacing(9)),calc(var(--available-height)---spacing(9)))] scroll-py-1 overflow-y-auto overscroll-contain p-1 data-empty:p-0",
        className,
      )}
      {...props}
    />
  );
}

function AutocompleteItem({ className, ...props }: AutocompletePrimitive.Item.Props) {
  return (
    <AutocompletePrimitive.Item
      data-slot="autocomplete-item"
      className={cn(
        "relative flex w-full cursor-default items-center gap-2 rounded-md px-1.5 py-1 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

function AutocompleteEmpty({ className, ...props }: AutocompletePrimitive.Empty.Props) {
  return (
    <AutocompletePrimitive.Empty
      data-slot="autocomplete-empty"
      className={cn(
        "flex w-full justify-center py-2 text-center text-sm text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  Autocomplete,
  AutocompleteContent,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompleteTrigger,
  AutocompleteValue,
};
