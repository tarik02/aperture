"use client";

import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";

import { cn } from "../utils.ts";

function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={cn("aperture:grid aperture:w-full aperture:gap-2", className)}
      {...props}
    />
  );
}

function RadioGroupItem({ className, ...props }: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-item"
      className={cn(
        "aperture:peer aperture:relative aperture:flex aperture:aspect-square aperture:size-4 aperture:shrink-0 aperture:items-center aperture:justify-center aperture:rounded-full aperture:border aperture:border-input aperture:outline-none aperture:group-has-disabled/field:opacity-50 aperture:after:absolute aperture:after:-inset-x-3 aperture:after:-inset-y-2 aperture:focus-visible:border-ring aperture:focus-visible:ring-3 aperture:focus-visible:ring-ring/50 aperture:disabled:cursor-not-allowed aperture:disabled:opacity-50 aperture:aria-invalid:border-destructive aperture:aria-invalid:ring-3 aperture:aria-invalid:ring-destructive/20 aperture:dark:bg-input/30 aperture:data-checked:border-primary aperture:data-checked:bg-primary aperture:data-checked:text-primary-foreground",
        className,
      )}
      {...props}
    >
      <RadioPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="aperture:flex aperture:size-4 aperture:items-center aperture:justify-center"
      >
        <span className="aperture:size-2 aperture:rounded-full aperture:bg-primary-foreground" />
      </RadioPrimitive.Indicator>
    </RadioPrimitive.Root>
  );
}

export { RadioGroup, RadioGroupItem };
