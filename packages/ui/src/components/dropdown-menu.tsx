"use client";

import * as React from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";

import { cn } from "../utils.ts";
import { ChevronRightIcon, CheckIcon } from "lucide-react";
import { usePortalContainer } from "../portal.tsx";

function DropdownMenu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuPortal({ ...props }: MenuPrimitive.Portal.Props) {
  const container = usePortalContainer();
  return <MenuPrimitive.Portal data-slot="dropdown-menu-portal" container={container} {...props} />;
}

function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuContent({
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  className,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<MenuPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">) {
  return (
    <MenuPrimitive.Portal container={usePortalContainer()}>
      <MenuPrimitive.Positioner
        className="aperture:isolate aperture:z-50 aperture:outline-none"
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            "aperture:z-50 aperture:max-h-(--available-height) aperture:w-(--anchor-width) aperture:min-w-32 aperture:origin-(--transform-origin) aperture:overflow-x-hidden aperture:overflow-y-auto aperture:rounded-lg aperture:bg-popover aperture:p-1 aperture:text-popover-foreground aperture:shadow-md aperture:ring-1 aperture:ring-foreground/10 aperture:duration-100 aperture:outline-none aperture:data-[side=bottom]:slide-in-from-top-2 aperture:data-[side=inline-end]:slide-in-from-left-2 aperture:data-[side=inline-start]:slide-in-from-right-2 aperture:data-[side=left]:slide-in-from-right-2 aperture:data-[side=right]:slide-in-from-left-2 aperture:data-[side=top]:slide-in-from-bottom-2 aperture:data-open:animate-in aperture:data-open:fade-in-0 aperture:data-open:zoom-in-95 aperture:data-closed:animate-out aperture:data-closed:overflow-hidden aperture:data-closed:fade-out-0 aperture:data-closed:zoom-out-95",
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function DropdownMenuGroup({ ...props }: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<"div"> & {
  inset?: boolean;
}) {
  return (
    <div
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        "aperture:px-1.5 aperture:py-1 aperture:text-xs aperture:font-medium aperture:text-muted-foreground aperture:data-inset:pl-7",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "aperture:group/dropdown-menu-item aperture:relative aperture:flex aperture:cursor-default aperture:items-center aperture:gap-1.5 aperture:rounded-md aperture:px-1.5 aperture:py-1 aperture:text-sm aperture:outline-hidden aperture:select-none aperture:focus:bg-accent aperture:focus:text-accent-foreground aperture:not-data-[variant=destructive]:focus:**:text-accent-foreground aperture:data-inset:pl-7 aperture:data-[variant=destructive]:text-destructive aperture:data-[variant=destructive]:focus:bg-destructive/10 aperture:data-[variant=destructive]:focus:text-destructive aperture:dark:data-[variant=destructive]:focus:bg-destructive/20 aperture:data-disabled:pointer-events-none aperture:data-disabled:opacity-50 aperture:[&_svg]:pointer-events-none aperture:[&_svg]:shrink-0 aperture:[&_svg:not([class*='size-'])]:size-4 aperture:data-[variant=destructive]:*:[svg]:text-destructive",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSub({ ...props }: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />;
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "aperture:flex aperture:cursor-default aperture:items-center aperture:gap-1.5 aperture:rounded-md aperture:px-1.5 aperture:py-1 aperture:text-sm aperture:outline-hidden aperture:select-none aperture:focus:bg-accent aperture:focus:text-accent-foreground aperture:not-data-[variant=destructive]:focus:**:text-accent-foreground aperture:data-inset:pl-7 aperture:data-popup-open:bg-accent aperture:data-popup-open:text-accent-foreground aperture:data-open:bg-accent aperture:data-open:text-accent-foreground aperture:[&_svg]:pointer-events-none aperture:[&_svg]:shrink-0 aperture:[&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="aperture:ml-auto" />
    </MenuPrimitive.SubmenuTrigger>
  );
}

function DropdownMenuSubContent({
  align = "start",
  alignOffset = -3,
  side = "right",
  sideOffset = 0,
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuContent>) {
  return (
    <DropdownMenuContent
      data-slot="dropdown-menu-sub-content"
      className={cn(
        "aperture:w-auto aperture:min-w-[96px] aperture:rounded-lg aperture:bg-popover aperture:p-1 aperture:text-popover-foreground aperture:shadow-lg aperture:ring-1 aperture:ring-foreground/10 aperture:duration-100 aperture:data-[side=bottom]:slide-in-from-top-2 aperture:data-[side=left]:slide-in-from-right-2 aperture:data-[side=right]:slide-in-from-left-2 aperture:data-[side=top]:slide-in-from-bottom-2 aperture:data-open:animate-in aperture:data-open:fade-in-0 aperture:data-open:zoom-in-95 aperture:data-closed:animate-out aperture:data-closed:fade-out-0 aperture:data-closed:zoom-out-95",
        className,
      )}
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  ...props
}: MenuPrimitive.CheckboxItem.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      data-inset={inset}
      className={cn(
        "aperture:relative aperture:flex aperture:cursor-default aperture:items-center aperture:gap-1.5 aperture:rounded-md aperture:py-1 aperture:pr-8 aperture:pl-1.5 aperture:text-sm aperture:outline-hidden aperture:select-none aperture:focus:bg-accent aperture:focus:text-accent-foreground aperture:focus:**:text-accent-foreground aperture:data-inset:pl-7 aperture:data-disabled:pointer-events-none aperture:data-disabled:opacity-50 aperture:[&_svg]:pointer-events-none aperture:[&_svg]:shrink-0 aperture:[&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      checked={checked}
      {...props}
    >
      <span
        className="aperture:pointer-events-none aperture:absolute aperture:right-2 aperture:flex aperture:items-center aperture:justify-center"
        data-slot="dropdown-menu-checkbox-item-indicator"
      >
        <MenuPrimitive.CheckboxItemIndicator>
          <CheckIcon />
        </MenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </MenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuRadioGroup({ ...props }: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}

function DropdownMenuRadioItem({
  className,
  children,
  inset,
  ...props
}: MenuPrimitive.RadioItem.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      data-inset={inset}
      className={cn(
        "aperture:relative aperture:flex aperture:cursor-default aperture:items-center aperture:gap-1.5 aperture:rounded-md aperture:py-1 aperture:pr-8 aperture:pl-1.5 aperture:text-sm aperture:outline-hidden aperture:select-none aperture:focus:bg-accent aperture:focus:text-accent-foreground aperture:focus:**:text-accent-foreground aperture:data-inset:pl-7 aperture:data-disabled:pointer-events-none aperture:data-disabled:opacity-50 aperture:[&_svg]:pointer-events-none aperture:[&_svg]:shrink-0 aperture:[&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <span
        className="aperture:pointer-events-none aperture:absolute aperture:right-2 aperture:flex aperture:items-center aperture:justify-center"
        data-slot="dropdown-menu-radio-item-indicator"
      >
        <MenuPrimitive.RadioItemIndicator>
          <CheckIcon />
        </MenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  );
}

function DropdownMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("aperture:-mx-1 aperture:my-1 aperture:h-px aperture:bg-border", className)}
      {...props}
    />
  );
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(
        "aperture:ml-auto aperture:text-xs aperture:tracking-widest aperture:text-muted-foreground aperture:group-focus/dropdown-menu-item:text-accent-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};
