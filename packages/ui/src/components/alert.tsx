import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../utils.ts";

const alertVariants = cva(
  "aperture:group/alert aperture:relative aperture:grid aperture:w-full aperture:gap-0.5 aperture:rounded-lg aperture:border aperture:px-2.5 aperture:py-2 aperture:text-left aperture:text-sm aperture:has-data-[slot=alert-action]:relative aperture:has-data-[slot=alert-action]:pr-18 aperture:has-[>svg]:grid-cols-[auto_1fr] aperture:has-[>svg]:gap-x-2 aperture:*:[svg]:row-span-2 aperture:*:[svg]:translate-y-0.5 aperture:*:[svg]:text-current aperture:*:[svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "aperture:bg-card aperture:text-card-foreground",
        destructive:
          "aperture:bg-card aperture:text-destructive aperture:*:data-[slot=alert-description]:text-destructive/90 aperture:*:[svg]:text-current",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "aperture:font-medium aperture:group-has-[>svg]/alert:col-start-2 aperture:[&_a]:underline aperture:[&_a]:underline-offset-3 aperture:[&_a]:hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "aperture:text-sm aperture:text-balance aperture:text-muted-foreground aperture:md:text-pretty aperture:[&_a]:underline aperture:[&_a]:underline-offset-3 aperture:[&_a]:hover:text-foreground aperture:[&_p:not(:last-child)]:mb-4",
        className,
      )}
      {...props}
    />
  );
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-action"
      className={cn("aperture:absolute aperture:top-2 aperture:right-2", className)}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription, AlertAction };
