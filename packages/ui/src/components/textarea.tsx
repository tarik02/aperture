import * as React from "react";

import { cn } from "../utils.ts";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "aperture:flex aperture:field-sizing-content aperture:min-h-16 aperture:w-full aperture:rounded-lg aperture:border aperture:border-input aperture:bg-transparent aperture:px-2.5 aperture:py-2 aperture:text-base aperture:transition-colors aperture:outline-none aperture:placeholder:text-muted-foreground aperture:focus-visible:border-ring aperture:focus-visible:ring-3 aperture:focus-visible:ring-ring/50 aperture:disabled:cursor-not-allowed aperture:disabled:bg-input/50 aperture:disabled:opacity-50 aperture:aria-invalid:border-destructive aperture:aria-invalid:ring-3 aperture:aria-invalid:ring-destructive/20 aperture:md:text-sm aperture:dark:bg-input/30 aperture:dark:disabled:bg-input/80 aperture:dark:aria-invalid:border-destructive/50 aperture:dark:aria-invalid:ring-destructive/40",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
