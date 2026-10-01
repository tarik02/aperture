import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";

import { cn } from "../utils.ts";

function Separator({ className, orientation = "horizontal", ...props }: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        "aperture:shrink-0 aperture:bg-border aperture:data-horizontal:h-px aperture:data-horizontal:w-full aperture:data-vertical:w-px aperture:data-vertical:self-stretch",
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
