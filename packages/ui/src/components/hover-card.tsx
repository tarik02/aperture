"use client";

import { PreviewCard as PreviewCardPrimitive } from "@base-ui/react/preview-card";

import { cn } from "../utils.ts";
import { usePortalContainer } from "../portal.tsx";

function HoverCard<Payload>(props: PreviewCardPrimitive.Root.Props<Payload>) {
  return <PreviewCardPrimitive.Root data-slot="hover-card" {...props} />;
}

function HoverCardTrigger<Payload>(props: PreviewCardPrimitive.Trigger.Props<Payload>) {
  return <PreviewCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />;
}

function HoverCardContent({
  className,
  side = "bottom",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  collisionPadding,
  ...props
}: PreviewCardPrimitive.Popup.Props &
  Pick<
    PreviewCardPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset" | "collisionPadding"
  >) {
  return (
    <PreviewCardPrimitive.Portal container={usePortalContainer()}>
      <PreviewCardPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className="aperture:isolate aperture:z-50"
      >
        <PreviewCardPrimitive.Popup
          data-slot="hover-card-content"
          className={cn(
            "aperture:z-50 aperture:w-64 aperture:rounded-lg aperture:bg-popover aperture:p-2.5 aperture:text-sm aperture:text-popover-foreground aperture:shadow-md aperture:ring-1 aperture:ring-foreground/10 aperture:outline-hidden",
            className,
          )}
          {...props}
        />
      </PreviewCardPrimitive.Positioner>
    </PreviewCardPrimitive.Portal>
  );
}

const createHoverCardHandle = PreviewCardPrimitive.createHandle;

export { HoverCard, HoverCardTrigger, HoverCardContent, createHoverCardHandle };
export type HoverCardHandle<Payload> = PreviewCardPrimitive.Handle<Payload>;
