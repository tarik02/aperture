"use client";

import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer";

import { cn } from "../utils.ts";
import { usePortalContainer } from "../portal.tsx";

/** How the sheet and what dims the page behind it move: as a sheet of a phone's own does. */
const MOVES =
  "aperture:duration-[450ms] aperture:ease-[cubic-bezier(0.32,0.72,0,1)] aperture:data-swiping:duration-0 aperture:data-ending-style:duration-[calc(var(--drawer-swipe-strength,1)*400ms)] aperture:motion-reduce:duration-0";

function Drawer({ ...props }: DrawerPrimitive.Root.Props) {
  return <DrawerPrimitive.Root data-slot="drawer" {...props} />;
}

function DrawerTrigger({ ...props }: DrawerPrimitive.Trigger.Props) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}

function DrawerClose({ ...props }: DrawerPrimitive.Close.Props) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

/**
 * A sheet at the window's foot that is dragged: down to be rid of it, and between the
 * heights its root names as `snapPoints`. What scrolls in it is a `DrawerBody`.
 */
function DrawerContent({ className, children, ...props }: DrawerPrimitive.Popup.Props) {
  return (
    <DrawerPrimitive.Portal container={usePortalContainer()}>
      <DrawerPrimitive.Backdrop
        data-slot="drawer-overlay"
        className={cn(
          "aperture:fixed aperture:inset-0 aperture:z-50 aperture:bg-black aperture:opacity-[calc(0.12+0.2*(1-var(--drawer-swipe-progress,0)))] aperture:transition-opacity aperture:data-closed:pointer-events-none aperture:data-ending-style:opacity-0 aperture:data-starting-style:opacity-0",
          MOVES,
        )}
      />
      <DrawerPrimitive.Viewport
        data-slot="drawer-viewport"
        className="aperture:fixed aperture:inset-0 aperture:z-50 aperture:flex aperture:touch-none aperture:items-end aperture:justify-center aperture:data-closed:pointer-events-none"
      >
        <DrawerPrimitive.Popup
          data-slot="drawer-content"
          className={cn(
            // What is below a height it is dragged to is off the window: the room it
            // takes there is left empty, so that all it holds is scrolled to above it.
            "aperture:relative aperture:flex aperture:max-h-[calc(100dvh-env(safe-area-inset-top)-1.5rem)] aperture:min-h-0 aperture:w-full aperture:touch-none aperture:flex-col aperture:rounded-t-2xl aperture:bg-popover aperture:[padding-bottom:max(0px,calc(var(--drawer-snap-point-offset,0px)+var(--drawer-swipe-movement-y,0px)))] aperture:text-sm aperture:text-popover-foreground aperture:shadow-lg aperture:ring-1 aperture:ring-foreground/10 aperture:outline-none aperture:[transform:translateY(calc(var(--drawer-snap-point-offset,0px)+var(--drawer-swipe-movement-y,0px)))] aperture:transition-transform aperture:data-ending-style:[padding-bottom:0] aperture:data-ending-style:[transform:translateY(100%)] aperture:data-starting-style:[padding-bottom:0] aperture:data-starting-style:[transform:translateY(100%)] aperture:data-swiping:select-none",
            // Dragged above where it rests, it shows nothing of the page below its foot.
            "aperture:after:pointer-events-none aperture:after:absolute aperture:after:inset-x-0 aperture:after:top-full aperture:after:h-24 aperture:after:bg-[inherit]",
            MOVES,
            className,
          )}
          {...props}
        >
          <div
            aria-hidden
            data-slot="drawer-handle"
            className="aperture:mx-auto aperture:mt-2 aperture:h-1 aperture:w-9 aperture:shrink-0 aperture:rounded-full aperture:bg-foreground/20"
          />
          {children}
        </DrawerPrimitive.Popup>
      </DrawerPrimitive.Viewport>
    </DrawerPrimitive.Portal>
  );
}

/** What the sheet holds that scrolls: dragging it moves the sheet once it is at its top. */
function DrawerBody({ className, ...props }: DrawerPrimitive.Content.Props) {
  return (
    <DrawerPrimitive.Content
      data-slot="drawer-body"
      className={cn(
        "aperture:min-h-0 aperture:flex-1 aperture:touch-auto aperture:overflow-y-auto aperture:overscroll-contain",
        className,
      )}
      {...props}
    />
  );
}

function DrawerTitle({ className, ...props }: DrawerPrimitive.Title.Props) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn("aperture:text-base aperture:font-medium aperture:text-foreground", className)}
      {...props}
    />
  );
}

function DrawerDescription({ className, ...props }: DrawerPrimitive.Description.Props) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn("aperture:text-sm aperture:text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Drawer,
  DrawerTrigger,
  DrawerClose,
  DrawerContent,
  DrawerBody,
  DrawerTitle,
  DrawerDescription,
};
