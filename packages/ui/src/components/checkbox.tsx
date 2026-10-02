"use client";

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";

import { cn } from "../utils.ts";
import { CheckIcon } from "lucide-react";

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "aperture:peer aperture:relative aperture:flex aperture:size-4 aperture:shrink-0 aperture:items-center aperture:justify-center aperture:rounded-[4px] aperture:border aperture:border-input aperture:transition-colors aperture:outline-none aperture:group-has-disabled/field:opacity-50 aperture:after:absolute aperture:after:-inset-x-3 aperture:after:-inset-y-2 aperture:focus-visible:border-ring aperture:focus-visible:ring-3 aperture:focus-visible:ring-ring/50 aperture:disabled:cursor-not-allowed aperture:disabled:opacity-50 aperture:aria-invalid:border-destructive aperture:aria-invalid:ring-3 aperture:aria-invalid:ring-destructive/20 aperture:aria-invalid:aria-checked:border-primary aperture:dark:bg-input/30 aperture:dark:aria-invalid:border-destructive/50 aperture:dark:aria-invalid:ring-destructive/40 aperture:data-checked:border-primary aperture:data-checked:bg-primary aperture:data-checked:text-primary-foreground aperture:dark:data-checked:bg-primary",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="aperture:grid aperture:place-content-center aperture:text-current aperture:transition-none aperture:[&>svg]:size-3.5"
      >
        <CheckIcon />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
