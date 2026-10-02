"use client";

import * as React from "react";
import { Combobox as ComboboxPrimitive } from "@base-ui/react";

import { cn } from "../utils.ts";
import { Button } from "./button.tsx";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "./input-group.tsx";
import { ChevronDownIcon, XIcon, CheckIcon } from "lucide-react";
import { usePortalContainer } from "../portal.tsx";

const Combobox = ComboboxPrimitive.Root;

function ComboboxValue({ ...props }: ComboboxPrimitive.Value.Props) {
  return <ComboboxPrimitive.Value data-slot="combobox-value" {...props} />;
}

function ComboboxTrigger({ className, children, ...props }: ComboboxPrimitive.Trigger.Props) {
  return (
    <ComboboxPrimitive.Trigger
      data-slot="combobox-trigger"
      className={cn("aperture:[&_svg:not([class*='size-'])]:size-4", className)}
      {...props}
    >
      {children}
      <ChevronDownIcon className="aperture:pointer-events-none aperture:size-4 aperture:text-muted-foreground" />
    </ComboboxPrimitive.Trigger>
  );
}

function ComboboxClear({ className, ...props }: ComboboxPrimitive.Clear.Props) {
  return (
    <ComboboxPrimitive.Clear
      data-slot="combobox-clear"
      render={<InputGroupButton variant="ghost" size="icon-xs" />}
      className={cn(className)}
      {...props}
    >
      <XIcon className="aperture:pointer-events-none" />
    </ComboboxPrimitive.Clear>
  );
}

function ComboboxInput({
  className,
  children,
  disabled = false,
  showTrigger = true,
  showClear = false,
  ...props
}: ComboboxPrimitive.Input.Props & {
  showTrigger?: boolean;
  showClear?: boolean;
}) {
  return (
    <InputGroup className={cn("aperture:w-auto", className)}>
      <ComboboxPrimitive.Input render={<InputGroupInput disabled={disabled} />} {...props} />
      <InputGroupAddon align="inline-end">
        {showTrigger && (
          <InputGroupButton
            size="icon-xs"
            variant="ghost"
            render={<ComboboxTrigger />}
            data-slot="input-group-button"
            className="aperture:group-has-data-[slot=combobox-clear]/input-group:hidden aperture:data-pressed:bg-transparent"
            disabled={disabled}
          />
        )}
        {showClear && <ComboboxClear disabled={disabled} />}
      </InputGroupAddon>
      {children}
    </InputGroup>
  );
}

function ComboboxContent({
  className,
  side = "bottom",
  sideOffset = 6,
  align = "start",
  alignOffset = 0,
  anchor,
  ...props
}: ComboboxPrimitive.Popup.Props &
  Pick<
    ComboboxPrimitive.Positioner.Props,
    "side" | "align" | "sideOffset" | "alignOffset" | "anchor"
  >) {
  return (
    <ComboboxPrimitive.Portal container={usePortalContainer()}>
      <ComboboxPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        className="aperture:isolate aperture:z-50"
      >
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          data-chips={!!anchor}
          className={cn(
            "aperture:group/combobox-content aperture:relative aperture:max-h-(--available-height) aperture:w-(--anchor-width) aperture:max-w-(--available-width) aperture:min-w-[calc(var(--anchor-width)+--spacing(7))] aperture:origin-(--transform-origin) aperture:overflow-hidden aperture:rounded-lg aperture:bg-popover aperture:text-popover-foreground aperture:shadow-md aperture:ring-1 aperture:ring-foreground/10 aperture:duration-100 aperture:data-[chips=true]:min-w-(--anchor-width) aperture:data-[side=bottom]:slide-in-from-top-2 aperture:data-[side=inline-end]:slide-in-from-left-2 aperture:data-[side=inline-start]:slide-in-from-right-2 aperture:data-[side=left]:slide-in-from-right-2 aperture:data-[side=right]:slide-in-from-left-2 aperture:data-[side=top]:slide-in-from-bottom-2 aperture:*:data-[slot=input-group]:m-1 aperture:*:data-[slot=input-group]:mb-0 aperture:*:data-[slot=input-group]:h-8 aperture:*:data-[slot=input-group]:border-input/30 aperture:*:data-[slot=input-group]:bg-input/30 aperture:*:data-[slot=input-group]:shadow-none aperture:data-open:animate-in aperture:data-open:fade-in-0 aperture:data-open:zoom-in-95 aperture:data-closed:animate-out aperture:data-closed:fade-out-0 aperture:data-closed:zoom-out-95",
            className,
          )}
          {...props}
        />
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}

function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props) {
  return (
    <ComboboxPrimitive.List
      data-slot="combobox-list"
      className={cn(
        "no-scrollbar aperture:max-h-[min(calc(--spacing(72)---spacing(9)),calc(var(--available-height)---spacing(9)))] aperture:scroll-py-1 aperture:overflow-y-auto aperture:overscroll-contain aperture:p-1 aperture:data-empty:p-0",
        className,
      )}
      {...props}
    />
  );
}

function ComboboxItem({ className, children, ...props }: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item
      data-slot="combobox-item"
      className={cn(
        "aperture:relative aperture:flex aperture:w-full aperture:cursor-default aperture:items-center aperture:gap-2 aperture:rounded-md aperture:py-1 aperture:pr-8 aperture:pl-1.5 aperture:text-sm aperture:outline-hidden aperture:select-none aperture:data-highlighted:bg-accent aperture:data-highlighted:text-accent-foreground aperture:not-data-[variant=destructive]:data-highlighted:**:text-accent-foreground aperture:data-disabled:pointer-events-none aperture:data-disabled:opacity-50 aperture:[&_svg]:pointer-events-none aperture:[&_svg]:shrink-0 aperture:[&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      {children}
      <ComboboxPrimitive.ItemIndicator
        render={
          <span className="aperture:pointer-events-none aperture:absolute aperture:right-2 aperture:flex aperture:size-4 aperture:items-center aperture:justify-center" />
        }
      >
        <CheckIcon className="aperture:pointer-events-none" />
      </ComboboxPrimitive.ItemIndicator>
    </ComboboxPrimitive.Item>
  );
}

function ComboboxGroup({ className, ...props }: ComboboxPrimitive.Group.Props) {
  return (
    <ComboboxPrimitive.Group data-slot="combobox-group" className={cn(className)} {...props} />
  );
}

function ComboboxLabel({ className, ...props }: ComboboxPrimitive.GroupLabel.Props) {
  return (
    <ComboboxPrimitive.GroupLabel
      data-slot="combobox-label"
      className={cn(
        "aperture:px-2 aperture:py-1.5 aperture:text-xs aperture:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function ComboboxCollection({ ...props }: ComboboxPrimitive.Collection.Props) {
  return <ComboboxPrimitive.Collection data-slot="combobox-collection" {...props} />;
}

function ComboboxEmpty({ className, ...props }: ComboboxPrimitive.Empty.Props) {
  return (
    <ComboboxPrimitive.Empty
      data-slot="combobox-empty"
      className={cn(
        "aperture:hidden aperture:w-full aperture:justify-center aperture:py-2 aperture:text-center aperture:text-sm aperture:text-muted-foreground aperture:group-data-empty/combobox-content:flex",
        className,
      )}
      {...props}
    />
  );
}

function ComboboxSeparator({ className, ...props }: ComboboxPrimitive.Separator.Props) {
  return (
    <ComboboxPrimitive.Separator
      data-slot="combobox-separator"
      className={cn("aperture:-mx-1 aperture:my-1 aperture:h-px aperture:bg-border", className)}
      {...props}
    />
  );
}

function ComboboxChips({
  className,
  ...props
}: React.ComponentPropsWithRef<typeof ComboboxPrimitive.Chips> & ComboboxPrimitive.Chips.Props) {
  return (
    <ComboboxPrimitive.Chips
      data-slot="combobox-chips"
      className={cn(
        "aperture:flex aperture:min-h-8 aperture:flex-wrap aperture:items-center aperture:gap-1 aperture:rounded-lg aperture:border aperture:border-input aperture:bg-transparent aperture:bg-clip-padding aperture:px-2.5 aperture:py-1 aperture:text-sm aperture:transition-colors aperture:focus-within:border-ring aperture:focus-within:ring-3 aperture:focus-within:ring-ring/50 aperture:has-aria-invalid:border-destructive aperture:has-aria-invalid:ring-3 aperture:has-aria-invalid:ring-destructive/20 aperture:has-data-[slot=combobox-chip]:px-1 aperture:dark:bg-input/30 aperture:dark:has-aria-invalid:border-destructive/50 aperture:dark:has-aria-invalid:ring-destructive/40",
        className,
      )}
      {...props}
    />
  );
}

function ComboboxChip({
  className,
  children,
  showRemove = true,
  ...props
}: ComboboxPrimitive.Chip.Props & {
  showRemove?: boolean;
}) {
  return (
    <ComboboxPrimitive.Chip
      data-slot="combobox-chip"
      className={cn(
        "aperture:flex aperture:h-[calc(--spacing(5.25))] aperture:w-fit aperture:items-center aperture:justify-center aperture:gap-1 aperture:rounded-sm aperture:bg-muted aperture:px-1.5 aperture:text-xs aperture:font-medium aperture:whitespace-nowrap aperture:text-foreground aperture:has-disabled:pointer-events-none aperture:has-disabled:cursor-not-allowed aperture:has-disabled:opacity-50 aperture:has-data-[slot=combobox-chip-remove]:pr-0",
        className,
      )}
      {...props}
    >
      {children}
      {showRemove && (
        <ComboboxPrimitive.ChipRemove
          render={<Button variant="ghost" size="icon-xs" />}
          className="aperture:-ml-1 aperture:opacity-50 aperture:hover:opacity-100"
          data-slot="combobox-chip-remove"
        >
          <XIcon className="aperture:pointer-events-none" />
        </ComboboxPrimitive.ChipRemove>
      )}
    </ComboboxPrimitive.Chip>
  );
}

function ComboboxChipsInput({ className, ...props }: ComboboxPrimitive.Input.Props) {
  return (
    <ComboboxPrimitive.Input
      data-slot="combobox-chip-input"
      className={cn("aperture:min-w-16 aperture:flex-1 aperture:outline-none", className)}
      {...props}
    />
  );
}

function useComboboxAnchor() {
  return React.useRef<HTMLDivElement | null>(null);
}

export {
  Combobox,
  ComboboxInput,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxGroup,
  ComboboxLabel,
  ComboboxCollection,
  ComboboxEmpty,
  ComboboxSeparator,
  ComboboxChips,
  ComboboxChip,
  ComboboxChipsInput,
  ComboboxTrigger,
  ComboboxValue,
  useComboboxAnchor,
};
