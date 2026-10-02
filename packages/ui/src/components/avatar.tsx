import * as React from "react";
import { Avatar as AvatarPrimitive } from "@base-ui/react/avatar";

import { cn } from "../utils.ts";

function Avatar({
  className,
  size = "default",
  ...props
}: AvatarPrimitive.Root.Props & {
  size?: "default" | "sm" | "lg";
}) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      data-size={size}
      className={cn(
        "aperture:group/avatar aperture:relative aperture:flex aperture:size-8 aperture:shrink-0 aperture:rounded-full aperture:select-none aperture:after:absolute aperture:after:inset-0 aperture:after:rounded-full aperture:after:border aperture:after:border-border aperture:after:mix-blend-darken aperture:data-[size=lg]:size-10 aperture:data-[size=sm]:size-6 aperture:dark:after:mix-blend-lighten",
        className,
      )}
      {...props}
    />
  );
}

function AvatarImage({ className, ...props }: AvatarPrimitive.Image.Props) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn(
        "aperture:aspect-square aperture:size-full aperture:rounded-full aperture:object-cover",
        className,
      )}
      {...props}
    />
  );
}

function AvatarFallback({ className, ...props }: AvatarPrimitive.Fallback.Props) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn(
        "aperture:flex aperture:size-full aperture:items-center aperture:justify-center aperture:rounded-full aperture:bg-muted aperture:text-sm aperture:text-muted-foreground aperture:group-data-[size=sm]/avatar:text-xs",
        className,
      )}
      {...props}
    />
  );
}

function AvatarBadge({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="avatar-badge"
      className={cn(
        "aperture:absolute aperture:right-0 aperture:bottom-0 aperture:z-10 aperture:inline-flex aperture:items-center aperture:justify-center aperture:rounded-full aperture:bg-primary aperture:text-primary-foreground aperture:bg-blend-color aperture:ring-2 aperture:ring-background aperture:select-none",
        "aperture:group-data-[size=sm]/avatar:size-2 aperture:group-data-[size=sm]/avatar:[&>svg]:hidden",
        "aperture:group-data-[size=default]/avatar:size-2.5 aperture:group-data-[size=default]/avatar:[&>svg]:size-2",
        "aperture:group-data-[size=lg]/avatar:size-3 aperture:group-data-[size=lg]/avatar:[&>svg]:size-2",
        className,
      )}
      {...props}
    />
  );
}

function AvatarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="avatar-group"
      className={cn(
        "aperture:group/avatar-group aperture:flex aperture:-space-x-2 aperture:*:data-[slot=avatar]:ring-2 aperture:*:data-[slot=avatar]:ring-background",
        className,
      )}
      {...props}
    />
  );
}

function AvatarGroupCount({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="avatar-group-count"
      className={cn(
        "aperture:relative aperture:flex aperture:size-8 aperture:shrink-0 aperture:items-center aperture:justify-center aperture:rounded-full aperture:bg-muted aperture:text-sm aperture:text-muted-foreground aperture:ring-2 aperture:ring-background aperture:group-has-data-[size=lg]/avatar-group:size-10 aperture:group-has-data-[size=sm]/avatar-group:size-6 aperture:[&>svg]:size-4 aperture:group-has-data-[size=lg]/avatar-group:[&>svg]:size-5 aperture:group-has-data-[size=sm]/avatar-group:[&>svg]:size-3",
        className,
      )}
      {...props}
    />
  );
}

export { Avatar, AvatarImage, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarBadge };
