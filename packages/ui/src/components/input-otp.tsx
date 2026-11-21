import { OTPInput, OTPInputContext } from "input-otp";
import { MinusIcon } from "lucide-react";
import * as React from "react";

import { cn } from "../utils.ts";

function InputOTP({
  className,
  containerClassName,
  ...props
}: React.ComponentProps<typeof OTPInput> & {
  containerClassName?: string;
}) {
  return (
    <OTPInput
      data-slot="input-otp"
      containerClassName={cn(
        "aperture:flex aperture:items-center aperture:gap-2 aperture:has-disabled:opacity-50",
        containerClassName,
      )}
      className={cn("aperture:disabled:cursor-not-allowed", className)}
      {...props}
    />
  );
}

function InputOTPGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-otp-group"
      className={cn("aperture:flex aperture:items-center", className)}
      {...props}
    />
  );
}

function InputOTPSlot({
  index,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  index: number;
}) {
  const inputOTPContext = React.useContext(OTPInputContext);
  const { char, hasFakeCaret, isActive } = inputOTPContext?.slots[index] ?? {};

  return (
    <div
      data-slot="input-otp-slot"
      data-active={isActive}
      className={cn(
        "aperture:relative aperture:flex aperture:h-10 aperture:flex-1 aperture:items-center aperture:justify-center aperture:border-y aperture:border-r aperture:border-input aperture:text-base aperture:transition-all aperture:outline-none aperture:first:rounded-l-lg aperture:first:border-l aperture:last:rounded-r-lg aperture:data-[active=true]:z-10 aperture:data-[active=true]:border-ring aperture:data-[active=true]:ring-3 aperture:data-[active=true]:ring-ring/50 aperture:dark:bg-input/30",
        className,
      )}
      {...props}
    >
      {char}
      {hasFakeCaret ? (
        <div className="aperture:pointer-events-none aperture:absolute aperture:inset-0 aperture:flex aperture:items-center aperture:justify-center">
          <div className="aperture:h-4 aperture:w-px aperture:animate-caret-blink aperture:bg-foreground aperture:duration-1000" />
        </div>
      ) : null}
    </div>
  );
}

function InputOTPSeparator({ ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-otp-separator"
      role="separator"
      className="aperture:text-muted-foreground aperture:[&_svg]:size-4"
      {...props}
    >
      <MinusIcon />
    </div>
  );
}

export { InputOTP, InputOTPGroup, InputOTPSlot, InputOTPSeparator };
