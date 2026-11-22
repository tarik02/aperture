import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";

import { cn } from "../utils.ts";
import { Button } from "./button.tsx";
import { XIcon } from "lucide-react";
import { usePortalContainer } from "../portal.tsx";
import { ScrollArea } from "./scroll-area.tsx";

/** What opens over a dialog from within it, while it is open: a list, a menu. */
const POPUPS = [
  '[data-slot="select-content"][data-open]',
  '[data-slot="combobox-content"][data-open]',
  '[data-slot="autocomplete-content"][data-open]',
  '[data-slot$="menu-content"][data-open]',
  '[data-slot="popover-content"][data-open]',
].join(", ");

/**
 * The presses of Escape that found something open over a dialog. They are noted before
 * anything hears them: what was open closes on the same press, and is closed by the time
 * the dialog is asked to.
 */
const forPopup = new WeakSet<Event>();
if (typeof window !== "undefined") {
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && document.querySelector(POPUPS) !== null) {
        forPopup.add(event);
      }
    },
    true,
  );
}

function Dialog({
  onOpenChange,
  dismissible = true,
  ...props
}: DialogPrimitive.Root.Props & {
  /**
   * Whether Escape and a press beside it close it. Not where it shows what is shown once:
   * that is closed by a button of its own, and by nothing done in passing.
   */
  dismissible?: boolean;
}) {
  return (
    <DialogPrimitive.Root
      data-slot="dialog"
      onOpenChange={(open, details) => {
        if (
          !open &&
          !dismissible &&
          (details.reason === "escape-key" || details.reason === "outside-press")
        ) {
          details.cancel();
          return;
        }
        // Escape closes what opened last: a list that is open over the dialog, and not the
        // dialog with what was typed into it.
        if (!open && details.reason === "escape-key" && forPopup.has(details.event)) {
          details.cancel();
          return;
        }
        onOpenChange?.(open, details);
      }}
      {...props}
    />
  );
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  const container = usePortalContainer();
  return <DialogPrimitive.Portal data-slot="dialog-portal" container={container} {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      // Over a dialog it opened from as well: that one is behind it, and is seen to be.
      forceRender
      className={cn(
        "aperture:fixed aperture:inset-0 aperture:isolate aperture:z-50 aperture:bg-black/10 aperture:duration-100 aperture:supports-backdrop-filter:backdrop-blur-xs aperture:data-open:animate-in aperture:data-open:fade-in-0 aperture:data-closed:animate-out aperture:data-closed:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean;
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          // A column no taller than what is seen of the window: its header, its footer and
          // what else stands in it take the room they need, whatever the size of what is
          // pressed, and a `DialogBody` among them gives way and scrolls. With no body the
          // whole of it scrolls. On a phone it is a sheet at the foot, above the keyboard.
          "aperture:group/dialog aperture:fixed aperture:inset-x-0 aperture:bottom-(--keyboard-inset,0px) aperture:z-50 aperture:flex aperture:max-h-[calc(100dvh-0.75rem-env(safe-area-inset-top)-var(--keyboard-inset,0px)-var(--keyboard-top,0px))] aperture:w-full aperture:max-w-none aperture:flex-col aperture:gap-4 aperture:overflow-x-hidden aperture:overflow-y-auto aperture:rounded-t-xl aperture:bg-popover aperture:p-4 aperture:pb-(--dialog-pad-bottom) aperture:text-sm aperture:[--dialog-pad-bottom:max(1rem,env(safe-area-inset-bottom))] aperture:sm:[--dialog-pad-bottom:1rem] aperture:text-popover-foreground aperture:ring-1 aperture:ring-foreground/10 aperture:duration-100 aperture:outline-none aperture:data-closed:animate-out aperture:data-closed:fade-out-0 aperture:data-closed:slide-out-to-bottom-2 aperture:data-open:animate-in aperture:data-open:fade-in-0 aperture:data-open:slide-in-from-bottom-2 aperture:sm:top-[calc(var(--keyboard-top,0px)+(100svh-var(--keyboard-top,0px)-var(--keyboard-inset,0px))/2)] aperture:sm:left-1/2 aperture:sm:bottom-auto aperture:sm:max-h-[calc(100svh-2rem-var(--keyboard-top,0px)-var(--keyboard-inset,0px))] aperture:sm:max-w-md aperture:sm:-translate-x-1/2 aperture:sm:-translate-y-1/2 aperture:sm:rounded-xl aperture:sm:data-closed:zoom-out-95 aperture:sm:data-open:zoom-in-95",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={
              <Button
                variant="ghost"
                className="aperture:absolute aperture:top-2 aperture:right-2 aperture:pointer-coarse:top-1 aperture:pointer-coarse:right-1"
                size="icon-sm"
              />
            }
          >
            <XIcon />
            <span className="aperture:sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn(
        // Beside the button that closes it, where there is one.
        "aperture:flex aperture:min-w-0 aperture:shrink-0 aperture:flex-col aperture:gap-2 aperture:pb-2 aperture:group-has-[>[data-slot=dialog-close]]/dialog:pr-8",
        className,
      )}
      {...props}
    />
  );
}

/**
 * What a dialog holds between its header and footer: the part of it that gives way where
 * the window is short, and scrolls then. Its class is for how what it holds is laid out.
 */
function DialogBody({
  className,
  height,
  phoneHeight,
  style,
  ...props
}: Omit<React.ComponentProps<typeof ScrollArea>, "style"> & {
  /**
   * How tall it is whatever it holds, as a CSS length, where what it holds changes while the
   * dialog is open: tabs, a list that loads or grows. The room for the tallest of what it
   * shows, so that the dialog is as tall for each. Where what it holds is what is pressed,
   * the length counts those in `--control-height`, which is more where a finger presses.
   * Left out, it is as tall as what it holds.
   */
  height?: string;
  /** The same on a phone, where it is another: what it holds is in more lines there. */
  phoneHeight?: string;
  style?: React.CSSProperties;
}) {
  return (
    <ScrollArea
      data-slot="dialog-body"
      className={cn(
        // Out to the dialog's edges, so the rings of what has the focus are not cut off; and
        // further at its foot, where what stands out of the last thing it holds would
        // have it scroll: the line kept for what a field's rules say, the room a finger
        // has around a switch.
        "aperture:-mx-4 aperture:-mt-1 aperture:-mb-2 aperture:flex aperture:min-h-0 aperture:flex-col",
        height === undefined
          ? "aperture:shrink aperture:grow-0 aperture:basis-auto"
          : "aperture:shrink aperture:grow-0 aperture:basis-(--dialog-body-height) aperture:max-sm:basis-(--dialog-body-phone-height)",
      )}
      style={
        height === undefined
          ? style
          : ({
              "--dialog-body-height": height,
              "--dialog-body-phone-height": phoneHeight ?? height,
              ...style,
            } as React.CSSProperties)
      }
      viewportClassName={cn(
        "aperture:flex aperture:h-auto aperture:min-h-0 aperture:flex-1 aperture:flex-col aperture:gap-4 aperture:px-4 aperture:pt-1 aperture:pb-2",
        className,
      )}
      {...props}
    />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        // On a phone it stays at the sheet's foot while what is above it scrolls, clear of
        // the home indicator.
        "aperture:-mx-4 aperture:-mb-(--dialog-pad-bottom) aperture:flex aperture:shrink-0 aperture:gap-2 aperture:max-sm:*:min-w-0 aperture:max-sm:*:flex-1 aperture:border-t aperture:bg-[color-mix(in_oklch,var(--popover),var(--muted)_50%)] aperture:p-4 aperture:pb-(--dialog-pad-bottom) aperture:max-sm:sticky aperture:max-sm:-bottom-(--dialog-pad-bottom) aperture:sm:justify-end aperture:sm:rounded-b-xl",
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>Close</DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "aperture:min-w-0 aperture:text-base aperture:leading-tight aperture:font-medium aperture:wrap-anywhere",
        className,
      )}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "aperture:min-w-0 aperture:text-sm aperture:text-muted-foreground aperture:wrap-anywhere aperture:*:[a]:underline aperture:*:[a]:underline-offset-3 aperture:*:[a]:hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
