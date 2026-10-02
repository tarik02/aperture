import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../utils.ts";
import { Button } from "./button.tsx";
import { Input } from "./input.tsx";
import { Textarea } from "./textarea.tsx";

function InputGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-group"
      role="group"
      className={cn(
        "aperture:group/input-group aperture:relative aperture:flex aperture:h-8 aperture:w-full aperture:min-w-0 aperture:items-center aperture:rounded-lg aperture:border aperture:border-input aperture:transition-colors aperture:outline-none aperture:in-data-[slot=combobox-content]:focus-within:border-inherit aperture:in-data-[slot=combobox-content]:focus-within:ring-0 aperture:has-disabled:bg-input/50 aperture:has-disabled:opacity-50 aperture:has-[[data-slot=input-group-control]:focus-visible]:border-ring aperture:has-[[data-slot=input-group-control]:focus-visible]:ring-3 aperture:has-[[data-slot=input-group-control]:focus-visible]:ring-ring/50 aperture:has-[[data-slot][aria-invalid=true]]:border-destructive aperture:has-[[data-slot][aria-invalid=true]]:ring-3 aperture:has-[[data-slot][aria-invalid=true]]:ring-destructive/20 aperture:has-[>[data-align=block-end]]:h-auto aperture:has-[>[data-align=block-end]]:flex-col aperture:has-[>[data-align=block-start]]:h-auto aperture:has-[>[data-align=block-start]]:flex-col aperture:has-[>textarea]:h-auto aperture:dark:bg-input/30 aperture:dark:has-disabled:bg-input/80 aperture:dark:has-[[data-slot][aria-invalid=true]]:ring-destructive/40 aperture:has-[>[data-align=block-end]]:[&>input]:pt-3 aperture:has-[>[data-align=block-start]]:[&>input]:pb-3 aperture:has-[>[data-align=inline-end]]:[&>input]:pr-1.5 aperture:has-[>[data-align=inline-start]]:[&>input]:pl-1.5",
        className,
      )}
      {...props}
    />
  );
}

const inputGroupAddonVariants = cva(
  "aperture:flex aperture:h-auto aperture:cursor-text aperture:items-center aperture:justify-center aperture:gap-2 aperture:py-1.5 aperture:text-sm aperture:font-medium aperture:text-muted-foreground aperture:select-none aperture:group-data-[disabled=true]/input-group:opacity-50 aperture:[&>kbd]:rounded-[calc(var(--radius)-5px)] aperture:[&>svg:not([class*='size-'])]:size-4",
  {
    variants: {
      align: {
        "inline-start":
          "aperture:order-first aperture:pl-2 aperture:has-[>button]:ml-[-0.3rem] aperture:has-[>kbd]:ml-[-0.15rem]",
        "inline-end":
          "aperture:order-last aperture:pr-2 aperture:has-[>button]:mr-[-0.3rem] aperture:has-[>kbd]:mr-[-0.15rem]",
        "block-start":
          "aperture:order-first aperture:w-full aperture:justify-start aperture:px-2.5 aperture:pt-2 aperture:group-has-[>input]/input-group:pt-2 aperture:[[class~='aperture:border-b']]:pb-2",
        "block-end":
          "aperture:order-last aperture:w-full aperture:justify-start aperture:px-2.5 aperture:pb-2 aperture:group-has-[>input]/input-group:pb-2 aperture:[[class~='aperture:border-t']]:pt-2",
      },
    },
    defaultVariants: {
      align: "inline-start",
    },
  },
);

function InputGroupAddon({
  className,
  align = "inline-start",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof inputGroupAddonVariants>) {
  return (
    <div
      role="group"
      data-slot="input-group-addon"
      data-align={align}
      className={cn(inputGroupAddonVariants({ align }), className)}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) {
          return;
        }
        e.currentTarget.parentElement?.querySelector("input")?.focus();
      }}
      {...props}
    />
  );
}

const inputGroupButtonVariants = cva(
  "aperture:flex aperture:items-center aperture:gap-2 aperture:text-sm aperture:shadow-none",
  {
    variants: {
      size: {
        xs: "aperture:h-6 aperture:gap-1 aperture:rounded-[calc(var(--radius)-3px)] aperture:px-1.5 aperture:[&>svg:not([class*='size-'])]:size-3.5",
        sm: "",
        "icon-xs":
          "aperture:size-6 aperture:rounded-[calc(var(--radius)-3px)] aperture:p-0 aperture:has-[>svg]:p-0",
        "icon-sm": "aperture:size-8 aperture:p-0 aperture:has-[>svg]:p-0",
      },
    },
    defaultVariants: {
      size: "xs",
    },
  },
);

function InputGroupButton({
  className,
  type = "button",
  variant = "ghost",
  size = "xs",
  ...props
}: Omit<React.ComponentProps<typeof Button>, "size" | "type"> &
  VariantProps<typeof inputGroupButtonVariants> & {
    type?: "button" | "submit" | "reset";
  }) {
  return (
    <Button
      type={type}
      data-size={size}
      variant={variant}
      className={cn(inputGroupButtonVariants({ size }), className)}
      {...props}
    />
  );
}

function InputGroupText({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "aperture:flex aperture:items-center aperture:gap-2 aperture:text-sm aperture:text-muted-foreground aperture:[&_svg]:pointer-events-none aperture:[&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function InputGroupInput({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <Input
      data-slot="input-group-control"
      className={cn(
        "aperture:flex-1 aperture:rounded-none aperture:border-0 aperture:bg-transparent aperture:shadow-none aperture:ring-0 aperture:focus-visible:ring-0 aperture:disabled:bg-transparent aperture:aria-invalid:ring-0 aperture:dark:bg-transparent aperture:dark:disabled:bg-transparent",
        className,
      )}
      {...props}
    />
  );
}

function InputGroupTextarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <Textarea
      data-slot="input-group-control"
      className={cn(
        "aperture:flex-1 aperture:resize-none aperture:rounded-none aperture:border-0 aperture:bg-transparent aperture:py-2 aperture:shadow-none aperture:ring-0 aperture:focus-visible:ring-0 aperture:disabled:bg-transparent aperture:aria-invalid:ring-0 aperture:dark:bg-transparent aperture:dark:disabled:bg-transparent",
        className,
      )}
      {...props}
    />
  );
}

export {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupInput,
  InputGroupTextarea,
};
