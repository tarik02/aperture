"use client";

import * as React from "react";
import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";

import { cn } from "../utils.ts";
import { Button } from "./button.tsx";
import { XIcon } from "lucide-react";
import { usePortalContainer } from "../portal.tsx";

function Sheet({ ...props }: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger({ ...props }: SheetPrimitive.Trigger.Props) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose({ ...props }: SheetPrimitive.Close.Props) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetPortal({ ...props }: SheetPrimitive.Portal.Props) {
  const container = usePortalContainer();
  return <SheetPrimitive.Portal data-slot="sheet-portal" container={container} {...props} />;
}

function SheetOverlay({ className, ...props }: SheetPrimitive.Backdrop.Props) {
  return (
    <SheetPrimitive.Backdrop
      data-slot="sheet-overlay"
      className={cn(
        "aperture:fixed aperture:inset-0 aperture:z-50 aperture:bg-black/10 aperture:transition-opacity aperture:duration-150 aperture:data-ending-style:opacity-0 aperture:data-starting-style:opacity-0 aperture:supports-backdrop-filter:backdrop-blur-xs",
        className,
      )}
      {...props}
    />
  );
}

function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  ...props
}: SheetPrimitive.Popup.Props & {
  side?: "top" | "right" | "bottom" | "left";
  showCloseButton?: boolean;
}) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        data-side={side}
        className={cn(
          "aperture:fixed aperture:z-50 aperture:flex aperture:flex-col aperture:gap-4 aperture:bg-popover aperture:bg-clip-padding aperture:text-sm aperture:text-popover-foreground aperture:shadow-lg aperture:transition aperture:duration-200 aperture:ease-in-out aperture:data-ending-style:opacity-0 aperture:data-starting-style:opacity-0 aperture:data-[side=bottom]:inset-x-0 aperture:data-[side=bottom]:bottom-0 aperture:data-[side=bottom]:h-auto aperture:data-[side=bottom]:border-t aperture:data-[side=bottom]:data-ending-style:translate-y-[2.5rem] aperture:data-[side=bottom]:data-starting-style:translate-y-[2.5rem] aperture:data-[side=left]:inset-y-0 aperture:data-[side=left]:left-0 aperture:data-[side=left]:h-full aperture:data-[side=left]:w-3/4 aperture:data-[side=left]:border-r aperture:data-[side=left]:data-ending-style:translate-x-[-2.5rem] aperture:data-[side=left]:data-starting-style:translate-x-[-2.5rem] aperture:data-[side=right]:inset-y-0 aperture:data-[side=right]:right-0 aperture:data-[side=right]:h-full aperture:data-[side=right]:w-3/4 aperture:data-[side=right]:border-l aperture:data-[side=right]:data-ending-style:translate-x-[2.5rem] aperture:data-[side=right]:data-starting-style:translate-x-[2.5rem] aperture:data-[side=top]:inset-x-0 aperture:data-[side=top]:top-0 aperture:data-[side=top]:h-auto aperture:data-[side=top]:border-b aperture:data-[side=top]:data-ending-style:translate-y-[-2.5rem] aperture:data-[side=top]:data-starting-style:translate-y-[-2.5rem] aperture:data-[side=left]:sm:max-w-sm aperture:data-[side=right]:sm:max-w-sm",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close
            data-slot="sheet-close"
            render={
              <Button
                variant="ghost"
                className="aperture:absolute aperture:top-3 aperture:right-3"
                size="icon-sm"
              />
            }
          >
            <XIcon />
            <span className="aperture:sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Popup>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("aperture:flex aperture:flex-col aperture:gap-0.5 aperture:p-4", className)}
      {...props}
    />
  );
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn(
        "aperture:mt-auto aperture:flex aperture:flex-col aperture:gap-2 aperture:p-4",
        className,
      )}
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("aperture:text-base aperture:font-medium aperture:text-foreground", className)}
      {...props}
    />
  );
}

function SheetDescription({ className, ...props }: SheetPrimitive.Description.Props) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("aperture:text-sm aperture:text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
