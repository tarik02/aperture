import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../utils.ts";

const buttonVariants = cva(
  "aperture:group/button aperture:inline-flex aperture:shrink-0 aperture:items-center aperture:justify-center aperture:rounded-lg aperture:border aperture:border-transparent aperture:bg-clip-padding aperture:text-sm aperture:leading-none aperture:font-medium aperture:whitespace-nowrap aperture:transition-all aperture:outline-none aperture:select-none aperture:focus-visible:border-ring aperture:focus-visible:ring-3 aperture:focus-visible:ring-ring/50 aperture:active:not-aria-[haspopup]:translate-y-px aperture:disabled:pointer-events-none aperture:disabled:opacity-50 aperture:aria-invalid:border-destructive aperture:aria-invalid:ring-3 aperture:aria-invalid:ring-destructive/20 aperture:dark:aria-invalid:border-destructive/50 aperture:dark:aria-invalid:ring-destructive/40 aperture:[&_svg]:pointer-events-none aperture:[&_svg]:shrink-0 aperture:[&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "aperture:bg-primary aperture:text-primary-foreground aperture:hover:bg-primary/80",
        outline:
          "aperture:border-border aperture:bg-background aperture:hover:bg-muted aperture:hover:text-foreground aperture:aria-expanded:bg-muted aperture:aria-expanded:text-foreground aperture:dark:border-input aperture:dark:bg-input/30 aperture:dark:hover:bg-input/50",
        secondary:
          "aperture:bg-secondary aperture:text-secondary-foreground aperture:hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aperture:aria-expanded:bg-secondary aperture:aria-expanded:text-secondary-foreground",
        ghost:
          "aperture:hover:bg-muted aperture:hover:text-foreground aperture:aria-expanded:bg-muted aperture:aria-expanded:text-foreground aperture:dark:hover:bg-muted/50",
        destructive:
          "aperture:bg-destructive/10 aperture:text-destructive aperture:hover:bg-destructive/20 aperture:focus-visible:border-destructive/40 aperture:focus-visible:ring-destructive/20 aperture:dark:bg-destructive/20 aperture:dark:hover:bg-destructive/30 aperture:dark:focus-visible:ring-destructive/40",
        link: "aperture:text-primary aperture:underline-offset-4 aperture:hover:underline",
      },
      size: {
        default:
          "aperture:h-8 aperture:gap-1.5 aperture:px-2.5 aperture:pt-px aperture:has-data-[icon=inline-end]:pr-2 aperture:has-data-[icon=inline-start]:pl-2",
        xs: "aperture:h-6 aperture:gap-1 aperture:rounded-[min(--theme(--radius-md),10px)] aperture:px-2 aperture:pt-px aperture:text-xs aperture:in-data-[slot=button-group]:rounded-lg aperture:has-data-[icon=inline-end]:pr-1.5 aperture:has-data-[icon=inline-start]:pl-1.5 aperture:[&_svg:not([class*='size-'])]:size-3",
        sm: "aperture:h-7 aperture:gap-1 aperture:rounded-[min(--theme(--radius-md),12px)] aperture:px-2.5 aperture:pt-px aperture:text-[0.8rem] aperture:in-data-[slot=button-group]:rounded-lg aperture:has-data-[icon=inline-end]:pr-1.5 aperture:has-data-[icon=inline-start]:pl-1.5 aperture:[&_svg:not([class*='size-'])]:size-3.5",
        lg: "aperture:h-9 aperture:gap-1.5 aperture:px-2.5 aperture:pt-px aperture:has-data-[icon=inline-end]:pr-2 aperture:has-data-[icon=inline-start]:pl-2",
        icon: "aperture:size-8",
        "icon-xs":
          "aperture:size-6 aperture:rounded-[min(--theme(--radius-md),10px)] aperture:in-data-[slot=button-group]:rounded-lg aperture:[&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "aperture:size-7 aperture:rounded-[min(--theme(--radius-md),12px)] aperture:in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "aperture:size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
