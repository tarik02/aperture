import * as React from "react";
import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";

import { Button } from "./button.tsx";
import { cn } from "../utils.ts";
import { usePortalContainer } from "../portal.tsx";

function AlertDialog({ ...props }: AlertDialogPrimitive.Root.Props) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

function AlertDialogTrigger({ ...props }: AlertDialogPrimitive.Trigger.Props) {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

function AlertDialogPortal({ ...props }: AlertDialogPrimitive.Portal.Props) {
  const container = usePortalContainer();
  return (
    <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" container={container} {...props} />
  );
}

function AlertDialogOverlay({ className, ...props }: AlertDialogPrimitive.Backdrop.Props) {
  return (
    <AlertDialogPrimitive.Backdrop
      data-slot="alert-dialog-overlay"
      className={cn(
        "aperture:fixed aperture:inset-0 aperture:isolate aperture:z-50 aperture:bg-black/10 aperture:duration-100 aperture:supports-backdrop-filter:backdrop-blur-xs aperture:data-open:animate-in aperture:data-open:fade-in-0 aperture:data-closed:animate-out aperture:data-closed:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogContent({
  className,
  size = "default",
  ...props
}: AlertDialogPrimitive.Popup.Props & {
  size?: "default" | "sm";
}) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Popup
        data-slot="alert-dialog-content"
        data-size={size}
        className={cn(
          "aperture:group/alert-dialog-content aperture:fixed aperture:inset-x-0 aperture:bottom-0 aperture:z-50 aperture:grid aperture:w-full aperture:max-w-none aperture:gap-4 aperture:rounded-t-xl aperture:bg-popover aperture:p-4 aperture:text-popover-foreground aperture:ring-1 aperture:ring-foreground/10 aperture:duration-100 aperture:outline-none aperture:data-[size=default]:sm:max-w-sm aperture:data-[size=sm]:sm:max-w-xs aperture:data-closed:animate-out aperture:data-closed:fade-out-0 aperture:data-closed:slide-out-to-bottom-2 aperture:data-open:animate-in aperture:data-open:fade-in-0 aperture:data-open:slide-in-from-bottom-2 aperture:sm:top-1/2 aperture:sm:left-1/2 aperture:sm:bottom-auto aperture:sm:-translate-x-1/2 aperture:sm:-translate-y-1/2 aperture:sm:rounded-xl aperture:sm:data-closed:zoom-out-95 aperture:sm:data-open:zoom-in-95",
          className,
        )}
        {...props}
      />
    </AlertDialogPortal>
  );
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn(
        "aperture:grid aperture:grid-rows-[auto_1fr] aperture:place-items-center aperture:gap-1.5 aperture:text-center aperture:has-data-[slot=alert-dialog-media]:grid-rows-[auto_auto_1fr] aperture:has-data-[slot=alert-dialog-media]:gap-x-4 aperture:sm:group-data-[size=default]/alert-dialog-content:place-items-start aperture:sm:group-data-[size=default]/alert-dialog-content:text-left aperture:sm:group-data-[size=default]/alert-dialog-content:has-data-[slot=alert-dialog-media]:grid-rows-[auto_1fr]",
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn(
        "aperture:-mx-4 aperture:-mb-4 aperture:flex aperture:flex-col-reverse aperture:gap-2 aperture:rounded-b-xl aperture:border-t aperture:bg-muted/50 aperture:p-4 aperture:group-data-[size=sm]/alert-dialog-content:grid aperture:group-data-[size=sm]/alert-dialog-content:grid-cols-2 aperture:sm:flex-row aperture:sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogMedia({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-media"
      className={cn(
        "aperture:mb-2 aperture:inline-flex aperture:size-10 aperture:items-center aperture:justify-center aperture:rounded-md aperture:bg-muted aperture:sm:group-data-[size=default]/alert-dialog-content:row-span-2 aperture:*:[svg:not([class*='size-'])]:size-6",
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogTitle({ className, ...props }: AlertDialogPrimitive.Title.Props) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn(
        "aperture:text-base aperture:font-medium aperture:sm:group-data-[size=default]/alert-dialog-content:group-has-data-[slot=alert-dialog-media]/alert-dialog-content:col-start-2",
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogDescription({ className, ...props }: AlertDialogPrimitive.Description.Props) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn(
        "aperture:text-sm aperture:text-balance aperture:text-muted-foreground aperture:md:text-pretty aperture:*:[a]:underline aperture:*:[a]:underline-offset-3 aperture:*:[a]:hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogAction({ className, ...props }: React.ComponentProps<typeof Button>) {
  return <Button data-slot="alert-dialog-action" className={cn(className)} {...props} />;
}

function AlertDialogCancel({
  className,
  variant = "outline",
  size = "default",
  ...props
}: AlertDialogPrimitive.Close.Props &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <AlertDialogPrimitive.Close
      data-slot="alert-dialog-cancel"
      className={cn(className)}
      render={<Button variant={variant} size={size} />}
      {...props}
    />
  );
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
};
