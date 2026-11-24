import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../utils.ts";

import { Separator } from "./separator.tsx";

const buttonGroupVariants = cva(
  "aperture:flex aperture:w-fit aperture:items-stretch aperture:*:focus-visible:relative aperture:*:focus-visible:z-10 aperture:has-[>[data-slot=button-group]]:gap-2 aperture:has-[select[aria-hidden=true]:last-child]:[&>[data-slot=select-trigger]:last-of-type]:rounded-r-lg aperture:[&>[data-slot=select-trigger]:not([class*='w-'])]:w-fit aperture:[&>input]:flex-1",
  {
    variants: {
      orientation: {
        horizontal:
          "aperture:*:data-slot:rounded-r-none aperture:[&>[data-slot]:not(:has(~[data-slot]))]:rounded-r-lg! aperture:[&>[data-slot]~[data-slot]]:rounded-l-none aperture:[&>[data-slot]~[data-slot]]:border-l-0",
        vertical:
          "aperture:flex-col aperture:*:data-slot:rounded-b-none aperture:[&>[data-slot]:not(:has(~[data-slot]))]:rounded-b-lg! aperture:[&>[data-slot]~[data-slot]]:rounded-t-none aperture:[&>[data-slot]~[data-slot]]:border-t-0",
      },
    },
    defaultVariants: {
      orientation: "horizontal",
    },
  },
);

function ButtonGroup({
  className,
  orientation,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof buttonGroupVariants>) {
  return (
    <div
      role="group"
      data-slot="button-group"
      data-orientation={orientation}
      className={cn(buttonGroupVariants({ orientation }), className)}
      {...props}
    />
  );
}

function ButtonGroupText({ className, render, ...props }: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      {
        className: cn(
          "aperture:flex aperture:items-center aperture:gap-2 aperture:rounded-lg aperture:border aperture:bg-muted aperture:px-2.5 aperture:text-sm aperture:font-medium aperture:[&_svg]:pointer-events-none aperture:[&_svg:not([class*='size-'])]:size-4",
          className,
        ),
      },
      props,
    ),
    render,
    state: {
      slot: "aperture:button-group-text",
    },
  });
}

function ButtonGroupSeparator({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="button-group-separator"
      orientation={orientation}
      className={cn(
        "aperture:relative aperture:self-stretch aperture:bg-input aperture:data-horizontal:mx-px aperture:data-horizontal:w-auto aperture:data-vertical:my-px aperture:data-vertical:h-auto",
        className,
      )}
      {...props}
    />
  );
}

export { ButtonGroup, ButtonGroupSeparator, ButtonGroupText, buttonGroupVariants };
