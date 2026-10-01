import * as React from "react";
import { Select as SelectPrimitive } from "@base-ui/react/select";

import { cn } from "../utils.ts";
import { ChevronDownIcon, CheckIcon, ChevronUpIcon } from "lucide-react";
import { usePortalContainer } from "../portal.tsx";

const Select = SelectPrimitive.Root;

function SelectGroup({ className, ...props }: SelectPrimitive.Group.Props) {
  return (
    <SelectPrimitive.Group
      data-slot="select-group"
      className={cn("aperture:scroll-my-1 aperture:p-1", className)}
      {...props}
    />
  );
}

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn("aperture:flex aperture:flex-1 aperture:text-left", className)}
      {...props}
    />
  );
}

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: SelectPrimitive.Trigger.Props & {
  size?: "sm" | "default";
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "aperture:flex aperture:w-fit aperture:items-center aperture:justify-between aperture:gap-1.5 aperture:rounded-lg aperture:border aperture:border-input aperture:bg-transparent aperture:py-2 aperture:pr-2 aperture:pl-2.5 aperture:text-sm aperture:whitespace-nowrap aperture:transition-colors aperture:outline-none aperture:select-none aperture:focus-visible:border-ring aperture:focus-visible:ring-3 aperture:focus-visible:ring-ring/50 aperture:disabled:cursor-not-allowed aperture:disabled:opacity-50 aperture:aria-invalid:border-destructive aperture:aria-invalid:ring-3 aperture:aria-invalid:ring-destructive/20 aperture:data-placeholder:text-muted-foreground aperture:data-[size=default]:h-8 aperture:data-[size=sm]:h-7 aperture:data-[size=sm]:rounded-[min(--theme(--radius-md),10px)] aperture:*:data-[slot=select-value]:line-clamp-1 aperture:*:data-[slot=select-value]:flex aperture:*:data-[slot=select-value]:items-center aperture:*:data-[slot=select-value]:gap-1.5 aperture:dark:bg-input/30 aperture:dark:hover:bg-input/50 aperture:dark:aria-invalid:border-destructive/50 aperture:dark:aria-invalid:ring-destructive/40 aperture:[&_svg]:pointer-events-none aperture:[&_svg]:shrink-0 aperture:[&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon
        render={
          <ChevronDownIcon className="aperture:pointer-events-none aperture:size-4 aperture:text-muted-foreground" />
        }
      />
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  alignItemWithTrigger = true,
  ...props
}: SelectPrimitive.Popup.Props &
  Pick<
    SelectPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset" | "alignItemWithTrigger"
  >) {
  return (
    <SelectPrimitive.Portal container={usePortalContainer()}>
      <SelectPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        alignItemWithTrigger={alignItemWithTrigger}
        className="aperture:isolate aperture:z-50"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          data-align-trigger={alignItemWithTrigger}
          className={cn(
            "aperture:relative aperture:isolate aperture:z-50 aperture:max-h-(--available-height) aperture:w-(--anchor-width) aperture:min-w-36 aperture:origin-(--transform-origin) aperture:overflow-x-hidden aperture:overflow-y-auto aperture:rounded-lg aperture:bg-popover aperture:text-popover-foreground aperture:shadow-md aperture:ring-1 aperture:ring-foreground/10 aperture:duration-100 aperture:data-[align-trigger=true]:animate-none aperture:data-[side=bottom]:slide-in-from-top-2 aperture:data-[side=inline-end]:slide-in-from-left-2 aperture:data-[side=inline-start]:slide-in-from-right-2 aperture:data-[side=left]:slide-in-from-right-2 aperture:data-[side=right]:slide-in-from-left-2 aperture:data-[side=top]:slide-in-from-bottom-2 aperture:data-open:animate-in aperture:data-open:fade-in-0 aperture:data-open:zoom-in-95 aperture:data-closed:animate-out aperture:data-closed:fade-out-0 aperture:data-closed:zoom-out-95",
            className,
          )}
          {...props}
        >
          <SelectScrollUpButton />
          <SelectPrimitive.List>{children}</SelectPrimitive.List>
          <SelectScrollDownButton />
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({ className, ...props }: SelectPrimitive.GroupLabel.Props) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-label"
      className={cn(
        "aperture:px-1.5 aperture:py-1 aperture:text-xs aperture:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "aperture:relative aperture:flex aperture:w-full aperture:cursor-default aperture:items-center aperture:gap-1.5 aperture:rounded-md aperture:py-1 aperture:pr-8 aperture:pl-1.5 aperture:text-sm aperture:outline-hidden aperture:select-none aperture:focus:bg-accent aperture:focus:text-accent-foreground aperture:not-data-[variant=destructive]:focus:**:text-accent-foreground aperture:data-disabled:pointer-events-none aperture:data-disabled:opacity-50 aperture:[&_svg]:pointer-events-none aperture:[&_svg]:shrink-0 aperture:[&_svg:not([class*='size-'])]:size-4 aperture:*:[span]:last:flex aperture:*:[span]:last:items-center aperture:*:[span]:last:gap-2",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText className="aperture:flex aperture:flex-1 aperture:shrink-0 aperture:gap-2 aperture:whitespace-nowrap">
        {children}
      </SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator
        render={
          <span className="aperture:pointer-events-none aperture:absolute aperture:right-2 aperture:flex aperture:size-4 aperture:items-center aperture:justify-center" />
        }
      >
        <CheckIcon className="aperture:pointer-events-none" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({ className, ...props }: SelectPrimitive.Separator.Props) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn(
        "aperture:pointer-events-none aperture:-mx-1 aperture:my-1 aperture:h-px aperture:bg-border",
        className,
      )}
      {...props}
    />
  );
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpArrow>) {
  return (
    <SelectPrimitive.ScrollUpArrow
      data-slot="select-scroll-up-button"
      className={cn(
        "aperture:top-0 aperture:z-10 aperture:flex aperture:w-full aperture:cursor-default aperture:items-center aperture:justify-center aperture:bg-popover aperture:py-1 aperture:[&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <ChevronUpIcon />
    </SelectPrimitive.ScrollUpArrow>
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownArrow>) {
  return (
    <SelectPrimitive.ScrollDownArrow
      data-slot="select-scroll-down-button"
      className={cn(
        "aperture:bottom-0 aperture:z-10 aperture:flex aperture:w-full aperture:cursor-default aperture:items-center aperture:justify-center aperture:bg-popover aperture:py-1 aperture:[&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <ChevronDownIcon />
    </SelectPrimitive.ScrollDownArrow>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
