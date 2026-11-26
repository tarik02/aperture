import { OTPField as OTPFieldPrimitive } from "@base-ui/react/otp-field";
import * as React from "react";

import { cn } from "../utils.ts";

function OTPField({ className, ...props }: React.ComponentProps<typeof OTPFieldPrimitive.Root>) {
  return (
    <OTPFieldPrimitive.Root
      data-slot="otp-field"
      className={cn("aperture:flex aperture:w-full aperture:items-center", className)}
      {...props}
    />
  );
}

/** A box for one character: a real input each, which is what a password manager fills. */
function OTPFieldInput({
  className,
  ...props
}: React.ComponentProps<typeof OTPFieldPrimitive.Input>) {
  return (
    <OTPFieldPrimitive.Input
      data-slot="otp-field-input"
      className={cn(
        "aperture:relative aperture:h-10 aperture:w-full aperture:min-w-0 aperture:flex-1 aperture:border-y aperture:border-r aperture:border-input aperture:bg-transparent aperture:text-center aperture:text-base aperture:caret-foreground aperture:transition-all aperture:outline-none aperture:first:rounded-l-lg aperture:first:border-l aperture:last:rounded-r-lg aperture:focus-visible:z-10 aperture:focus-visible:border-ring aperture:focus-visible:ring-3 aperture:focus-visible:ring-ring/50 aperture:disabled:cursor-not-allowed aperture:disabled:opacity-50 aperture:aria-invalid:border-destructive aperture:dark:bg-input/30",
        className,
      )}
      {...props}
    />
  );
}

export { OTPField, OTPFieldInput };
