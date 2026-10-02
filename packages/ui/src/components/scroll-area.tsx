"use client";

import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";

import { cn } from "../utils.ts";

type ScrollAreaProps = ScrollAreaPrimitive.Root.Props & {
  viewportClassName?: string;
  scrollbars?: "vertical" | "horizontal" | "both";
};

function ScrollArea({
  className,
  viewportClassName,
  scrollbars = "vertical",
  children,
  ...props
}: ScrollAreaProps) {
  const vertical = scrollbars === "vertical" || scrollbars === "both";
  const horizontal = scrollbars === "horizontal" || scrollbars === "both";

  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("aperture:relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        style={{
          overflowX: horizontal ? "scroll" : "hidden",
          overflowY: vertical ? "scroll" : "hidden",
        }}
        className={cn(
          "aperture:size-full aperture:rounded-[inherit] aperture:transition-[color,box-shadow] aperture:outline-none aperture:focus-visible:ring-[3px] aperture:focus-visible:ring-ring/50 aperture:focus-visible:outline-1",
          viewportClassName,
        )}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      {vertical ? <ScrollBar /> : null}
      {horizontal ? <ScrollBar orientation="horizontal" /> : null}
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "aperture:flex aperture:touch-none aperture:p-px aperture:transition-colors aperture:select-none aperture:hover:bg-muted/50 aperture:data-[orientation=horizontal]:h-2.5 aperture:data-[orientation=horizontal]:flex-col aperture:data-[orientation=horizontal]:border-t aperture:data-[orientation=horizontal]:border-t-transparent aperture:data-[orientation=vertical]:h-full aperture:data-[orientation=vertical]:w-2.5 aperture:data-[orientation=vertical]:border-l aperture:data-[orientation=vertical]:border-l-transparent",
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="scroll-area-thumb"
        className="aperture:relative aperture:flex-1 aperture:rounded-full aperture:bg-foreground/35 aperture:transition-colors aperture:hover:bg-foreground/55"
      />
    </ScrollAreaPrimitive.Scrollbar>
  );
}

export { ScrollArea, ScrollBar };
