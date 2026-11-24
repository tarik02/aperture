import * as React from "react";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../utils.ts";

import { Separator } from "./separator.tsx";

function ItemGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="list"
      data-slot="item-group"
      className={cn(
        "aperture:group/item-group aperture:flex aperture:w-full aperture:flex-col aperture:gap-4 aperture:has-data-[size=sm]:gap-2.5 aperture:has-data-[size=xs]:gap-2",
        className,
      )}
      {...props}
    />
  );
}

function ItemSeparator({ className, ...props }: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="item-separator"
      orientation="horizontal"
      className={cn("aperture:my-2", className)}
      {...props}
    />
  );
}

const itemVariants = cva(
  "aperture:group/item aperture:flex aperture:w-full aperture:flex-wrap aperture:items-center aperture:rounded-lg aperture:border aperture:text-sm aperture:transition-colors aperture:duration-100 aperture:outline-none aperture:focus-visible:border-ring aperture:focus-visible:ring-[3px] aperture:focus-visible:ring-ring/50 aperture:[a]:transition-colors aperture:[a]:hover:bg-muted",
  {
    variants: {
      variant: {
        default: "aperture:border-transparent",
        outline: "aperture:border-border",
        muted: "aperture:border-transparent aperture:bg-muted/50",
      },
      size: {
        default: "aperture:gap-2.5 aperture:px-3 aperture:py-2.5",
        sm: "aperture:gap-2.5 aperture:px-3 aperture:py-2.5",
        xs: "aperture:gap-2 aperture:px-2.5 aperture:py-2 aperture:in-data-[slot=dropdown-menu-content]:p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Item({
  className,
  variant = "default",
  size = "default",
  render,
  ...props
}: useRender.ComponentProps<"div"> & VariantProps<typeof itemVariants>) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      {
        className: cn(itemVariants({ variant, size, className })),
      },
      props,
    ),
    render,
    state: {
      slot: "item",
      variant,
      size,
    },
  });
}

const itemMediaVariants = cva(
  "aperture:flex aperture:shrink-0 aperture:items-center aperture:justify-center aperture:gap-2 aperture:group-has-data-[slot=item-description]/item:translate-y-0.5 aperture:group-has-data-[slot=item-description]/item:self-start aperture:[&_svg]:pointer-events-none",
  {
    variants: {
      variant: {
        default: "aperture:bg-transparent",
        icon: "aperture:[&_svg:not([class*='size-'])]:size-4",
        image:
          "aperture:size-10 aperture:overflow-hidden aperture:rounded-sm aperture:group-data-[size=sm]/item:size-8 aperture:group-data-[size=xs]/item:size-6 aperture:[&_img]:size-full aperture:[&_img]:object-cover",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function ItemMedia({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof itemMediaVariants>) {
  return (
    <div
      data-slot="item-media"
      data-variant={variant}
      className={cn(itemMediaVariants({ variant, className }))}
      {...props}
    />
  );
}

function ItemContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-content"
      className={cn(
        "aperture:flex aperture:flex-1 aperture:flex-col aperture:gap-1 aperture:group-data-[size=xs]/item:gap-0 aperture:[&+[data-slot=item-content]]:flex-none",
        className,
      )}
      {...props}
    />
  );
}

function ItemTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-title"
      className={cn(
        "aperture:line-clamp-1 aperture:flex aperture:w-fit aperture:items-center aperture:gap-2 aperture:text-sm aperture:leading-snug aperture:font-medium aperture:underline-offset-4",
        className,
      )}
      {...props}
    />
  );
}

function ItemDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="item-description"
      className={cn(
        "aperture:line-clamp-2 aperture:text-left aperture:text-sm aperture:leading-normal aperture:font-normal aperture:text-muted-foreground aperture:group-data-[size=xs]/item:text-xs aperture:[&>a]:underline aperture:[&>a]:underline-offset-4 aperture:[&>a:hover]:text-primary",
        className,
      )}
      {...props}
    />
  );
}

function ItemActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-actions"
      className={cn("aperture:flex aperture:items-center aperture:gap-2", className)}
      {...props}
    />
  );
}

function ItemHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-header"
      className={cn(
        "aperture:flex aperture:basis-full aperture:items-center aperture:justify-between aperture:gap-2",
        className,
      )}
      {...props}
    />
  );
}

function ItemFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-footer"
      className={cn(
        "aperture:flex aperture:basis-full aperture:items-center aperture:justify-between aperture:gap-2",
        className,
      )}
      {...props}
    />
  );
}

export {
  Item,
  ItemMedia,
  ItemContent,
  ItemActions,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
  ItemDescription,
  ItemHeader,
  ItemFooter,
};
