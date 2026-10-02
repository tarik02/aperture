"use client";

import { Autocomplete as AutocompletePrimitive } from "@base-ui/react";
import { ChevronDownIcon, XIcon } from "lucide-react";

import { cn } from "../utils.ts";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "./input-group.tsx";
import { usePortalContainer } from "../portal.tsx";

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
      className={cn("aperture:[&_svg:not([class*='size-'])]:size-4", className)}
      {...props}
    >
      {children}
      <ChevronDownIcon className="aperture:pointer-events-none aperture:size-4 aperture:text-muted-foreground" />
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
      <XIcon className="aperture:pointer-events-none" />
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
    <InputGroup className={cn("aperture:w-auto", className)}>
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
    <AutocompletePrimitive.Portal container={usePortalContainer()}>
      <AutocompletePrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        className="aperture:isolate aperture:z-50"
      >
        <AutocompletePrimitive.Popup
          data-slot="autocomplete-content"
          className={cn(
            "aperture:relative aperture:max-h-(--available-height) aperture:w-(--anchor-width) aperture:max-w-(--available-width) aperture:origin-(--transform-origin) aperture:overflow-hidden aperture:rounded-lg aperture:bg-popover aperture:text-popover-foreground aperture:shadow-md aperture:ring-1 aperture:ring-foreground/10 aperture:duration-100 aperture:data-[side=bottom]:slide-in-from-top-2 aperture:data-[side=inline-end]:slide-in-from-left-2 aperture:data-[side=inline-start]:slide-in-from-right-2 aperture:data-[side=left]:slide-in-from-right-2 aperture:data-[side=right]:slide-in-from-left-2 aperture:data-[side=top]:slide-in-from-bottom-2 aperture:*:data-[slot=input-group]:m-1 aperture:*:data-[slot=input-group]:mb-0 aperture:*:data-[slot=input-group]:h-8 aperture:*:data-[slot=input-group]:border-input/30 aperture:*:data-[slot=input-group]:bg-input/30 aperture:*:data-[slot=input-group]:shadow-none aperture:data-open:animate-in aperture:data-open:fade-in-0 aperture:data-open:zoom-in-95 aperture:data-closed:animate-out aperture:data-closed:fade-out-0 aperture:data-closed:zoom-out-95",
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
        "no-scrollbar aperture:max-h-[min(calc(--spacing(72)---spacing(9)),calc(var(--available-height)---spacing(9)))] aperture:scroll-py-1 aperture:overflow-y-auto aperture:overscroll-contain aperture:p-1 aperture:data-empty:p-0",
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
        "aperture:relative aperture:flex aperture:w-full aperture:cursor-default aperture:items-center aperture:gap-2 aperture:rounded-md aperture:px-1.5 aperture:py-1 aperture:text-sm aperture:outline-hidden aperture:select-none aperture:data-highlighted:bg-accent aperture:data-highlighted:text-accent-foreground aperture:data-disabled:pointer-events-none aperture:data-disabled:opacity-50",
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
        "aperture:flex aperture:w-full aperture:justify-center aperture:py-2 aperture:text-center aperture:text-sm aperture:text-muted-foreground",
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
