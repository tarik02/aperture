import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";

import { cn } from "../utils.ts";
import { usePortalContainer } from "../portal.tsx";

function TooltipProvider({ delay = 0, ...props }: TooltipPrimitive.Provider.Props) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delay={delay} {...props} />;
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<TooltipPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">) {
  return (
    <TooltipPrimitive.Portal container={usePortalContainer()}>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="aperture:isolate aperture:z-50"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "aperture:z-50 aperture:inline-flex aperture:w-fit aperture:max-w-xs aperture:origin-(--transform-origin) aperture:items-center aperture:gap-1.5 aperture:rounded-md aperture:bg-foreground aperture:px-3 aperture:py-1.5 aperture:text-xs aperture:text-background aperture:has-data-[slot=kbd]:pr-1.5 aperture:data-[side=bottom]:slide-in-from-top-2 aperture:data-[side=inline-end]:slide-in-from-left-2 aperture:data-[side=inline-start]:slide-in-from-right-2 aperture:data-[side=left]:slide-in-from-right-2 aperture:data-[side=right]:slide-in-from-left-2 aperture:data-[side=top]:slide-in-from-bottom-2 aperture:**:data-[slot=kbd]:relative aperture:**:data-[slot=kbd]:isolate aperture:**:data-[slot=kbd]:z-50 aperture:**:data-[slot=kbd]:rounded-sm aperture:data-[state=delayed-open]:animate-in aperture:data-[state=delayed-open]:fade-in-0 aperture:data-[state=delayed-open]:zoom-in-95 aperture:data-open:animate-in aperture:data-open:fade-in-0 aperture:data-open:zoom-in-95 aperture:data-closed:animate-out aperture:data-closed:fade-out-0 aperture:data-closed:zoom-out-95",
            className,
          )}
          {...props}
        >
          {children}
          <TooltipPrimitive.Arrow className="aperture:z-50 aperture:size-2.5 aperture:translate-y-[calc(-50%-2px)] aperture:rotate-45 aperture:rounded-[2px] aperture:bg-foreground aperture:fill-foreground aperture:data-[side=bottom]:top-1 aperture:data-[side=inline-end]:top-1/2! aperture:data-[side=inline-end]:-left-1 aperture:data-[side=inline-end]:-translate-y-1/2 aperture:data-[side=inline-start]:top-1/2! aperture:data-[side=inline-start]:-right-1 aperture:data-[side=inline-start]:-translate-y-1/2 aperture:data-[side=left]:top-1/2! aperture:data-[side=left]:-right-1 aperture:data-[side=left]:-translate-y-1/2 aperture:data-[side=right]:top-1/2! aperture:data-[side=right]:-left-1 aperture:data-[side=right]:-translate-y-1/2 aperture:data-[side=top]:-bottom-2.5" />
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
