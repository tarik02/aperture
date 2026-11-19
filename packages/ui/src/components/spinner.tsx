import { Loader2Icon } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "../utils.ts";

function Spinner({ className, ...props }: ComponentProps<"svg">) {
  return (
    <Loader2Icon
      data-slot="spinner"
      role="status"
      aria-label="Loading"
      className={cn("aperture:size-4 aperture:animate-spin", className)}
      {...props}
    />
  );
}

export { Spinner };
