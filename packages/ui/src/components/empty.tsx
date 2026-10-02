import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../utils.ts";

function Empty({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty"
      className={cn(
        "aperture:flex aperture:w-full aperture:min-w-0 aperture:flex-1 aperture:flex-col aperture:items-center aperture:justify-center aperture:gap-4 aperture:rounded-xl aperture:border-dashed aperture:p-6 aperture:text-center aperture:text-balance",
        className,
      )}
      {...props}
    />
  );
}

function EmptyHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-header"
      className={cn(
        "aperture:flex aperture:max-w-sm aperture:flex-col aperture:items-center aperture:gap-2",
        className,
      )}
      {...props}
    />
  );
}

const emptyMediaVariants = cva(
  "aperture:mb-2 aperture:flex aperture:shrink-0 aperture:items-center aperture:justify-center aperture:[&_svg]:pointer-events-none aperture:[&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "aperture:bg-transparent",
        icon: "aperture:flex aperture:size-8 aperture:shrink-0 aperture:items-center aperture:justify-center aperture:rounded-lg aperture:bg-muted aperture:text-foreground aperture:[&_svg:not([class*='size-'])]:size-4",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function EmptyMedia({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof emptyMediaVariants>) {
  return (
    <div
      data-slot="empty-icon"
      data-variant={variant}
      className={cn(emptyMediaVariants({ variant, className }))}
      {...props}
    />
  );
}

function EmptyTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-title"
      className={cn("aperture:text-sm aperture:font-medium aperture:tracking-tight", className)}
      {...props}
    />
  );
}

function EmptyDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <div
      data-slot="empty-description"
      className={cn(
        "aperture:text-sm/relaxed aperture:text-muted-foreground aperture:[&>a]:underline aperture:[&>a]:underline-offset-4 aperture:[&>a:hover]:text-primary",
        className,
      )}
      {...props}
    />
  );
}

function EmptyContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-content"
      className={cn(
        "aperture:flex aperture:w-full aperture:max-w-sm aperture:min-w-0 aperture:flex-col aperture:items-center aperture:gap-2.5 aperture:text-sm aperture:text-balance",
        className,
      )}
      {...props}
    />
  );
}

export { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyContent, EmptyMedia };
