"use client";

import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../utils.ts";

const toggleVariants = cva(
  "aperture:group/toggle aperture:inline-flex aperture:items-center aperture:justify-center aperture:gap-1 aperture:rounded-lg aperture:text-sm aperture:font-medium aperture:whitespace-nowrap aperture:transition-all aperture:outline-none aperture:hover:bg-muted aperture:hover:text-foreground aperture:focus-visible:border-ring aperture:focus-visible:ring-[3px] aperture:focus-visible:ring-ring/50 aperture:disabled:pointer-events-none aperture:disabled:opacity-50 aperture:aria-invalid:border-destructive aperture:aria-invalid:ring-destructive/20 aperture:aria-pressed:bg-muted aperture:data-[state=on]:bg-muted aperture:dark:aria-invalid:ring-destructive/40 aperture:[&_svg]:pointer-events-none aperture:[&_svg]:shrink-0 aperture:[&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "aperture:bg-transparent",
        outline:
          "aperture:border aperture:border-input aperture:bg-transparent aperture:hover:bg-muted",
      },
      size: {
        default:
          "aperture:h-8 aperture:min-w-8 aperture:px-2.5 aperture:has-data-[icon=inline-end]:pr-2 aperture:has-data-[icon=inline-start]:pl-2",
        sm: "aperture:h-7 aperture:min-w-7 aperture:rounded-[min(--theme(--radius-md),12px)] aperture:px-2.5 aperture:text-[0.8rem] aperture:has-data-[icon=inline-end]:pr-1.5 aperture:has-data-[icon=inline-start]:pl-1.5 aperture:[&_svg:not([class*='size-'])]:size-3.5",
        lg: "aperture:h-9 aperture:min-w-9 aperture:px-2.5 aperture:has-data-[icon=inline-end]:pr-2 aperture:has-data-[icon=inline-start]:pl-2",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Toggle({
  className,
  variant = "default",
  size = "default",
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Toggle, toggleVariants };
