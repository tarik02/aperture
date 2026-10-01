import * as React from "react";
import { ChevronDownIcon } from "lucide-react";

import { cn } from "../utils.ts";

type NativeSelectProps = Omit<React.ComponentProps<"select">, "size"> & {
  size?: "sm" | "default";
};

function NativeSelect({ className, size = "default", ...props }: NativeSelectProps) {
  return (
    <div
      className={cn(
        "aperture:group/native-select aperture:relative aperture:w-fit aperture:has-[select:disabled]:opacity-50",
        className,
      )}
      data-slot="native-select-wrapper"
      data-size={size}
    >
      <select
        data-slot="native-select"
        data-size={size}
        className="aperture:h-8 aperture:w-full aperture:min-w-0 aperture:appearance-none aperture:rounded-lg aperture:border aperture:border-input aperture:bg-transparent aperture:py-1 aperture:pr-8 aperture:pl-2.5 aperture:text-sm aperture:transition-colors aperture:outline-none aperture:select-none aperture:selection:bg-primary aperture:selection:text-primary-foreground aperture:placeholder:text-muted-foreground aperture:focus-visible:border-ring aperture:focus-visible:ring-3 aperture:focus-visible:ring-ring/50 aperture:disabled:pointer-events-none aperture:disabled:cursor-not-allowed aperture:aria-invalid:border-destructive aperture:aria-invalid:ring-3 aperture:aria-invalid:ring-destructive/20 aperture:data-[size=sm]:h-7 aperture:data-[size=sm]:rounded-[min(--theme(--radius-md),10px)] aperture:data-[size=sm]:py-0.5 aperture:dark:bg-input/30 aperture:dark:hover:bg-input/50 aperture:dark:aria-invalid:border-destructive/50 aperture:dark:aria-invalid:ring-destructive/40"
        {...props}
      />
      <ChevronDownIcon
        className="aperture:pointer-events-none aperture:absolute aperture:top-1/2 aperture:right-2.5 aperture:size-4 aperture:-translate-y-1/2 aperture:text-muted-foreground aperture:select-none"
        aria-hidden="true"
        data-slot="native-select-icon"
      />
    </div>
  );
}

function NativeSelectOption({ className, ...props }: React.ComponentProps<"option">) {
  return (
    <option
      data-slot="native-select-option"
      className={cn("aperture:bg-[Canvas] aperture:text-[CanvasText]", className)}
      {...props}
    />
  );
}

function NativeSelectOptGroup({ className, ...props }: React.ComponentProps<"optgroup">) {
  return (
    <optgroup
      data-slot="native-select-optgroup"
      className={cn("aperture:bg-[Canvas] aperture:text-[CanvasText]", className)}
      {...props}
    />
  );
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption };
