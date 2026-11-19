import * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";

import { cn } from "../utils.ts";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "aperture:h-8 aperture:w-full aperture:min-w-0 aperture:rounded-lg aperture:border aperture:border-input aperture:bg-transparent aperture:px-2.5 aperture:py-1 aperture:text-base aperture:transition-colors aperture:outline-none aperture:file:inline-flex aperture:file:h-6 aperture:file:border-0 aperture:file:bg-transparent aperture:file:text-sm aperture:file:font-medium aperture:file:text-foreground aperture:placeholder:text-muted-foreground aperture:focus-visible:border-ring aperture:focus-visible:ring-3 aperture:focus-visible:ring-ring/50 aperture:disabled:pointer-events-none aperture:disabled:cursor-not-allowed aperture:disabled:bg-input/50 aperture:disabled:opacity-50 aperture:aria-invalid:border-destructive aperture:aria-invalid:ring-3 aperture:aria-invalid:ring-destructive/20 aperture:md:text-sm aperture:dark:bg-input/30 aperture:dark:disabled:bg-input/80 aperture:dark:aria-invalid:border-destructive/50 aperture:dark:aria-invalid:ring-destructive/40",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
