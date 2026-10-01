import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";

import { cn } from "../utils.ts";
import { Button } from "./button.tsx";
import { XIcon } from "lucide-react";
import { usePortalContainer } from "../portal.tsx";

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  const container = usePortalContainer();
  return <DialogPrimitive.Portal data-slot="dialog-portal" container={container} {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "aperture:fixed aperture:inset-0 aperture:isolate aperture:z-50 aperture:bg-black/10 aperture:duration-100 aperture:supports-backdrop-filter:backdrop-blur-xs aperture:data-open:animate-in aperture:data-open:fade-in-0 aperture:data-closed:animate-out aperture:data-closed:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean;
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          "aperture:fixed aperture:inset-x-0 aperture:bottom-0 aperture:z-50 aperture:grid aperture:max-h-[calc(100svh-0.75rem)] aperture:w-full aperture:max-w-none aperture:gap-4 aperture:overflow-y-auto aperture:rounded-t-xl aperture:bg-popover aperture:p-4 aperture:text-sm aperture:text-popover-foreground aperture:ring-1 aperture:ring-foreground/10 aperture:duration-100 aperture:outline-none aperture:data-closed:animate-out aperture:data-closed:fade-out-0 aperture:data-closed:slide-out-to-bottom-2 aperture:data-open:animate-in aperture:data-open:fade-in-0 aperture:data-open:slide-in-from-bottom-2 aperture:sm:top-1/2 aperture:sm:left-1/2 aperture:sm:bottom-auto aperture:sm:max-h-[calc(100svh-2rem)] aperture:sm:max-w-sm aperture:sm:-translate-x-1/2 aperture:sm:-translate-y-1/2 aperture:sm:rounded-xl aperture:sm:data-closed:zoom-out-95 aperture:sm:data-open:zoom-in-95",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={
              <Button
                variant="ghost"
                className="aperture:absolute aperture:top-2 aperture:right-2"
                size="icon-sm"
              />
            }
          >
            <XIcon />
            <span className="aperture:sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("aperture:flex aperture:flex-col aperture:gap-2 aperture:pb-2", className)}
      {...props}
    />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "aperture:-mx-4 aperture:-mb-4 aperture:flex aperture:flex-col-reverse aperture:gap-2 aperture:rounded-b-xl aperture:border-t aperture:bg-muted/50 aperture:p-4 aperture:sm:flex-row aperture:sm:justify-end",
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>Close</DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("aperture:text-base aperture:leading-none aperture:font-medium", className)}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "aperture:text-sm aperture:text-muted-foreground aperture:*:[a]:underline aperture:*:[a]:underline-offset-3 aperture:*:[a]:hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
