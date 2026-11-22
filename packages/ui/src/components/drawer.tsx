"use client";

import * as React from "react";
import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer";

import { cn } from "../utils.ts";
import { usePortalContainer } from "../portal.tsx";

/** The edge of the window a sheet stands at, and is dragged to to be rid of it. */
type DrawerSide = "bottom" | "left" | "right";

const SideContext = React.createContext<DrawerSide>("bottom");

const SWIPED = { bottom: "down", left: "left", right: "right" } as const;

/** How the sheet and what dims the page behind it move: as a sheet of a phone's own does. */
const MOVES =
  "aperture:duration-[450ms] aperture:ease-[cubic-bezier(0.32,0.72,0,1)] aperture:data-swiping:duration-0 aperture:data-ending-style:duration-[calc(var(--drawer-swipe-strength,1)*400ms)] aperture:motion-reduce:duration-0";

const BACKDROP = cn(
  "aperture:fixed aperture:inset-0 aperture:z-50 aperture:bg-black aperture:opacity-[calc(0.12+0.2*(1-var(--drawer-swipe-progress,0)))] aperture:transition-opacity aperture:data-closed:pointer-events-none aperture:data-ending-style:opacity-0 aperture:data-starting-style:opacity-0",
  MOVES,
);

/** Where a sheet is laid in the window: above the keyboard, where one is there. */
const VIEWPORT = {
  bottom: "aperture:items-end aperture:justify-center",
  left: "aperture:items-stretch aperture:justify-start",
  right: "aperture:items-stretch aperture:justify-end",
} as const;

const POPUP = {
  bottom: cn(
    // What is below a height it is dragged to is off the window: the room it takes there
    // is left empty, so that all it holds is scrolled to above it.
    "aperture:max-h-[calc(100%-env(safe-area-inset-top)-1.5rem)] aperture:w-full aperture:rounded-t-2xl aperture:[padding-bottom:max(0px,calc(var(--drawer-snap-point-offset,0px)+var(--drawer-swipe-movement-y,0px)))] aperture:[transform:translateY(calc(var(--drawer-snap-point-offset,0px)+var(--drawer-swipe-movement-y,0px)))] aperture:data-ending-style:[padding-bottom:0] aperture:data-ending-style:[transform:translateY(100%)] aperture:data-starting-style:[padding-bottom:0] aperture:data-starting-style:[transform:translateY(100%)]",
    // Dragged above where it rests, it shows nothing of the page below its foot.
    "aperture:after:inset-x-0 aperture:after:top-full aperture:after:h-24",
  ),
  left: cn(
    "aperture:h-full aperture:w-[min(calc(23rem+env(safe-area-inset-left)),calc(100%-3.5rem))] aperture:rounded-r-2xl aperture:pl-[env(safe-area-inset-left)] aperture:[transform:translateX(var(--drawer-swipe-movement-x,0px))] aperture:data-ending-style:[transform:translateX(-100%)] aperture:data-starting-style:[transform:translateX(-100%)]",
    "aperture:after:inset-y-0 aperture:after:right-full aperture:after:w-24",
  ),
  right: cn(
    "aperture:h-full aperture:w-[min(calc(23rem+env(safe-area-inset-right)),calc(100%-3.5rem))] aperture:rounded-l-2xl aperture:pr-[env(safe-area-inset-right)] aperture:[transform:translateX(var(--drawer-swipe-movement-x,0px))] aperture:data-ending-style:[transform:translateX(100%)] aperture:data-starting-style:[transform:translateX(100%)]",
    "aperture:after:inset-y-0 aperture:after:left-full aperture:after:w-24",
  ),
} as const;

/** The mark of where a sheet is dragged by: at its head, or along the edge it came in by. */
const HANDLE = {
  bottom: "aperture:mx-auto aperture:mt-2 aperture:h-1 aperture:w-9 aperture:shrink-0",
  left: "aperture:absolute aperture:top-1/2 aperture:right-1.5 aperture:h-9 aperture:w-1 aperture:-translate-y-1/2",
  right:
    "aperture:absolute aperture:top-1/2 aperture:left-1.5 aperture:h-9 aperture:w-1 aperture:-translate-y-1/2",
} as const;

/**
 * A sheet that follows the finger. At the window's foot it is dragged down to be rid of
 * it and between the heights named as `snapPoints`; at a `side` of the window, as where
 * the window is wider than tall, it is dragged to that side to be rid of it.
 */
function Drawer({
  side = "bottom",
  ...props
}: Omit<DrawerPrimitive.Root.Props, "swipeDirection"> & { side?: DrawerSide }) {
  return (
    <SideContext.Provider value={side}>
      <DrawerPrimitive.Root data-slot="drawer" swipeDirection={SWIPED[side]} {...props} />
    </SideContext.Provider>
  );
}

function DrawerTrigger({ ...props }: DrawerPrimitive.Trigger.Props) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}

function DrawerClose({ ...props }: DrawerPrimitive.Close.Props) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

/** What a sheet is made of, for what lays out a sheet's popup itself. */
function drawerPopupClassName(side: DrawerSide, className?: string) {
  return cn(
    "aperture:relative aperture:flex aperture:min-h-0 aperture:touch-none aperture:flex-col aperture:bg-popover aperture:text-sm aperture:text-popover-foreground aperture:shadow-lg aperture:ring-1 aperture:ring-foreground/10 aperture:outline-none aperture:transition-transform aperture:after:pointer-events-none aperture:after:absolute aperture:after:bg-[inherit] aperture:data-swiping:select-none",
    POPUP[side],
    MOVES,
    className,
  );
}

function DrawerHandle({ side }: { side: DrawerSide }) {
  return (
    <div
      aria-hidden
      data-slot="drawer-handle"
      className={cn("aperture:rounded-full aperture:bg-foreground/20", HANDLE[side])}
    />
  );
}

/** What dims the page behind a sheet, and where the sheet is laid over it. */
function DrawerFrame({ children }: { children: React.ReactNode }) {
  const side = React.useContext(SideContext);
  return (
    <DrawerPrimitive.Portal container={usePortalContainer()}>
      <DrawerPrimitive.Backdrop data-slot="drawer-overlay" className={BACKDROP} />
      <DrawerPrimitive.Viewport
        data-slot="drawer-viewport"
        className={cn(
          "aperture:fixed aperture:inset-x-0 aperture:top-0 aperture:bottom-(--keyboard-inset,0px) aperture:z-50 aperture:flex aperture:touch-none aperture:data-closed:pointer-events-none",
          VIEWPORT[side],
        )}
      >
        {children}
      </DrawerPrimitive.Viewport>
    </DrawerPrimitive.Portal>
  );
}

/** The sheet itself. What scrolls in it is a `DrawerBody`. */
function DrawerContent({ className, children, ...props }: DrawerPrimitive.Popup.Props) {
  const side = React.useContext(SideContext);
  return (
    <DrawerFrame>
      <DrawerPrimitive.Popup
        data-slot="drawer-content"
        data-side={side}
        className={
          typeof className === "function"
            ? (state) => drawerPopupClassName(side, className(state))
            : drawerPopupClassName(side, className)
        }
        {...props}
      >
        <DrawerHandle side={side} />
        {children}
      </DrawerPrimitive.Popup>
    </DrawerFrame>
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
  DrawerFrame,
  DrawerHandle,
  DrawerBody,
  DrawerTitle,
  DrawerDescription,
  drawerPopupClassName,
  type DrawerSide,
};
