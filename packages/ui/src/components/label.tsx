import * as React from "react";

import { cn } from "../utils.ts";

function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      className={cn(
        "aperture:flex aperture:items-center aperture:gap-2 aperture:text-sm aperture:leading-none aperture:font-medium aperture:select-none aperture:group-data-[disabled=true]:pointer-events-none aperture:group-data-[disabled=true]:opacity-50 aperture:peer-disabled:cursor-not-allowed aperture:peer-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Label };
