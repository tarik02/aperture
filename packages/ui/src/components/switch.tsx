import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "../utils.ts";

function Switch({
  className,
  size = "default",
  ...props
}: SwitchPrimitive.Root.Props & {
  size?: "sm" | "default";
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "aperture:peer aperture:group/switch aperture:relative aperture:inline-flex aperture:shrink-0 aperture:items-center aperture:rounded-full aperture:border aperture:border-transparent aperture:transition-all aperture:outline-none aperture:after:absolute aperture:after:-inset-x-3 aperture:after:-inset-y-2 aperture:focus-visible:border-ring aperture:focus-visible:ring-3 aperture:focus-visible:ring-ring/50 aperture:aria-invalid:border-destructive aperture:aria-invalid:ring-3 aperture:aria-invalid:ring-destructive/20 aperture:data-[size=default]:h-[18.4px] aperture:data-[size=default]:w-[32px] aperture:data-[size=sm]:h-[14px] aperture:data-[size=sm]:w-[24px] aperture:dark:aria-invalid:border-destructive/50 aperture:dark:aria-invalid:ring-destructive/40 aperture:data-checked:bg-primary aperture:data-unchecked:bg-input aperture:dark:data-unchecked:bg-input/80 aperture:data-disabled:cursor-not-allowed aperture:data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="aperture:pointer-events-none aperture:block aperture:rounded-full aperture:bg-background aperture:ring-0 aperture:transition-transform aperture:group-data-[size=default]/switch:size-4 aperture:group-data-[size=sm]/switch:size-3 aperture:group-data-[size=default]/switch:data-checked:translate-x-[calc(100%-2px)] aperture:group-data-[size=sm]/switch:data-checked:translate-x-[calc(100%-2px)] aperture:dark:data-checked:bg-primary-foreground aperture:group-data-[size=default]/switch:data-unchecked:translate-x-0 aperture:group-data-[size=sm]/switch:data-unchecked:translate-x-0 aperture:dark:data-unchecked:bg-foreground"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
