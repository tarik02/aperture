import * as React from "react";

import { cn } from "../utils.ts";

function Card({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"div"> & { size?: "default" | "sm" }) {
  return (
    <div
      data-slot="card"
      data-size={size}
      className={cn(
        "aperture:group/card aperture:flex aperture:flex-col aperture:gap-(--card-spacing) aperture:overflow-hidden aperture:rounded-xl aperture:bg-card aperture:py-(--card-spacing) aperture:text-sm aperture:text-card-foreground aperture:ring-1 aperture:ring-foreground/10 aperture:[--card-spacing:--spacing(4)] aperture:has-data-[slot=card-footer]:pb-0 aperture:has-[>img:first-child]:pt-0 aperture:data-[size=sm]:[--card-spacing:--spacing(3)] aperture:data-[size=sm]:has-data-[slot=card-footer]:pb-0 aperture:*:[img:first-child]:rounded-t-xl aperture:*:[img:last-child]:rounded-b-xl",
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "aperture:group/card-header aperture:@container/card-header aperture:grid aperture:auto-rows-min aperture:items-start aperture:gap-1 aperture:rounded-t-xl aperture:px-(--card-spacing) aperture:has-data-[slot=card-action]:grid-cols-[1fr_auto] aperture:has-data-[slot=card-description]:grid-rows-[auto_auto] aperture:[[class~='aperture:border-b']]:pb-(--card-spacing)",
        className,
      )}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn(
        "aperture:text-base aperture:leading-snug aperture:font-medium aperture:group-data-[size=sm]/card:text-sm",
        className,
      )}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("aperture:text-sm aperture:text-muted-foreground", className)}
      {...props}
    />
  );
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "aperture:col-start-2 aperture:row-span-2 aperture:row-start-1 aperture:self-start aperture:justify-self-end",
        className,
      )}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("aperture:px-(--card-spacing)", className)}
      {...props}
    />
  );
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "aperture:flex aperture:items-center aperture:rounded-b-xl aperture:border-t aperture:bg-muted/50 aperture:p-(--card-spacing)",
        className,
      )}
      {...props}
    />
  );
}

export { Card, CardHeader, CardFooter, CardTitle, CardAction, CardDescription, CardContent };
