import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../utils.ts";

const badgeVariants = cva(
  "aperture:group/badge aperture:inline-flex aperture:h-5 aperture:w-fit aperture:shrink-0 aperture:items-center aperture:justify-center aperture:gap-1 aperture:overflow-hidden aperture:rounded-4xl aperture:border aperture:border-transparent aperture:px-2 aperture:py-0.5 aperture:text-xs aperture:font-medium aperture:whitespace-nowrap aperture:transition-all aperture:focus-visible:border-ring aperture:focus-visible:ring-[3px] aperture:focus-visible:ring-ring/50 aperture:has-data-[icon=inline-end]:pr-1.5 aperture:has-data-[icon=inline-start]:pl-1.5 aperture:aria-invalid:border-destructive aperture:aria-invalid:ring-destructive/20 aperture:dark:aria-invalid:ring-destructive/40 aperture:[&>svg]:pointer-events-none aperture:[&>svg]:size-3!",
  {
    variants: {
      variant: {
        default:
          "aperture:bg-primary aperture:text-primary-foreground aperture:[a]:hover:bg-primary/80",
        secondary:
          "aperture:bg-secondary aperture:text-secondary-foreground aperture:[a]:hover:bg-secondary/80",
        destructive:
          "aperture:bg-destructive/10 aperture:text-destructive aperture:focus-visible:ring-destructive/20 aperture:dark:bg-destructive/20 aperture:dark:focus-visible:ring-destructive/40 aperture:[a]:hover:bg-destructive/20",
        outline:
          "aperture:border-border aperture:text-foreground aperture:[a]:hover:bg-muted aperture:[a]:hover:text-muted-foreground",
        ghost:
          "aperture:hover:bg-muted aperture:hover:text-muted-foreground aperture:dark:hover:bg-muted/50",
        link: "aperture:text-primary aperture:underline-offset-4 aperture:hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props,
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  });
}

export { Badge, badgeVariants };
