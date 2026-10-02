"use client";

import * as React from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import { cn } from "../utils.ts";
import { usePortalContainer } from "../portal.tsx";

function Popover({ ...props }: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
  className,
  align = "center",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<PopoverPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">) {
  return (
    <PopoverPrimitive.Portal container={usePortalContainer()}>
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="aperture:isolate aperture:z-50"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "aperture:z-50 aperture:flex aperture:w-72 aperture:origin-(--transform-origin) aperture:flex-col aperture:gap-2.5 aperture:rounded-lg aperture:bg-popover aperture:p-2.5 aperture:text-sm aperture:text-popover-foreground aperture:shadow-md aperture:ring-1 aperture:ring-foreground/10 aperture:outline-hidden aperture:duration-100 aperture:data-[side=bottom]:slide-in-from-top-2 aperture:data-[side=inline-end]:slide-in-from-left-2 aperture:data-[side=inline-start]:slide-in-from-right-2 aperture:data-[side=left]:slide-in-from-right-2 aperture:data-[side=right]:slide-in-from-left-2 aperture:data-[side=top]:slide-in-from-bottom-2 aperture:data-open:animate-in aperture:data-open:fade-in-0 aperture:data-open:zoom-in-95 aperture:data-closed:animate-out aperture:data-closed:fade-out-0 aperture:data-closed:zoom-out-95",
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("aperture:flex aperture:flex-col aperture:gap-0.5 aperture:text-sm", className)}
      {...props}
    />
  );
}

function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
  return (
    <PopoverPrimitive.Title
      data-slot="popover-title"
      className={cn("aperture:font-medium", className)}
      {...props}
    />
  );
}

function PopoverDescription({ className, ...props }: PopoverPrimitive.Description.Props) {
  return (
    <PopoverPrimitive.Description
      data-slot="popover-description"
      className={cn("aperture:text-muted-foreground", className)}
      {...props}
    />
  );
}

export { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger };
