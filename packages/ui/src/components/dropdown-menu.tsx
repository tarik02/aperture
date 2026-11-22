"use client";

import * as React from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";

import { cn } from "../utils.ts";
import { ChevronLeftIcon, ChevronRightIcon, CheckIcon } from "lucide-react";
import { usePortalContainer } from "../portal.tsx";

/**
 * Whether the menu is a sheet at the window's foot, as a phone has it: its submenus are
 * then pages that slide in over it, each with the way back, in place of menus beside it.
 */
const SheetContext = React.createContext(false);

/** The submenu a part is of, where the menu is a sheet. */
const SheetSubContext = React.createContext<
  | {
      readonly close: () => void;
      /** What opens it, which names its page. */
      readonly trigger: React.RefObject<HTMLElement | null>;
    }
  | undefined
>(undefined);

/**
 * Where a sheet stands, whatever the menu's anchor says: at the window's foot, across it,
 * and as tall for every page of it, so that it keeps its height from one page to the next.
 */
const SHEET_PLACE =
  "aperture:fixed! aperture:inset-x-0! aperture:top-auto! aperture:bottom-0! aperture:isolate aperture:z-50 aperture:h-[min(40rem,calc(100dvh-env(safe-area-inset-top)-3rem))] aperture:transform-none! aperture:overflow-hidden aperture:rounded-t-2xl aperture:outline-none";

/** A sheet's page, which scrolls within itself. */
const SHEET_PAGE =
  "aperture:flex aperture:size-full aperture:flex-col aperture:overflow-x-hidden aperture:overflow-y-auto aperture:overscroll-contain aperture:rounded-t-2xl aperture:bg-popover aperture:pr-[max(0.5rem,env(safe-area-inset-right))] aperture:pb-[max(0.5rem,env(safe-area-inset-bottom))] aperture:pl-[max(0.5rem,env(safe-area-inset-left))] aperture:text-popover-foreground aperture:outline-none";

/** A sheet's row: as tall as a finger needs, and written larger than a menu's. */
const SHEET_ROW =
  "aperture:min-h-11 aperture:gap-3 aperture:rounded-lg aperture:px-3 aperture:text-[0.9375rem] aperture:[&_svg:not([class*='size-'])]:size-5";

/** A sheet's row that is checked or chosen, with the mark of that at its end. */
const SHEET_MARKED_ROW = cn(SHEET_ROW, "aperture:pr-10");

/** How far a sheet is dragged down before letting go of it is rid of it. */
const SHEET_DISMISSED_PX = 72;

/**
 * The top of a sheet's first page, which it is dragged down by: the sheet goes with the
 * finger, and is gone once it was dragged far enough.
 */
function SheetGrip({ onDismiss }: { onDismiss: (() => void) | undefined }) {
  const from = React.useRef<number | undefined>(undefined);
  const moved = (event: React.PointerEvent<HTMLDivElement>, by: number, settles: boolean) => {
    const sheet = event.currentTarget.closest<HTMLElement>("[data-menu-sheet]");
    if (sheet !== null) {
      sheet.style.transition = settles ? "transform 200ms ease-out" : "none";
      sheet.style.transform = by > 0 ? `translateY(${by}px)` : "";
    }
  };
  return (
    <div
      data-slot="dropdown-menu-sheet-grip"
      className="aperture:flex aperture:h-6 aperture:shrink-0 aperture:touch-none aperture:items-center aperture:justify-center"
      onPointerDown={(event) => {
        from.current = event.clientY;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (from.current !== undefined) {
          moved(event, event.clientY - from.current, false);
        }
      }}
      onPointerUp={(event) => {
        const by = from.current === undefined ? 0 : event.clientY - from.current;
        from.current = undefined;
        if (by > SHEET_DISMISSED_PX && onDismiss !== undefined) {
          onDismiss();
        } else {
          moved(event, 0, true);
        }
      }}
      onPointerCancel={(event) => {
        from.current = undefined;
        moved(event, 0, true);
      }}
    >
      <span
        aria-hidden
        className="aperture:h-1 aperture:w-9 aperture:rounded-full aperture:bg-foreground/20"
      />
    </div>
  );
}

function DropdownMenu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuPortal({ ...props }: MenuPrimitive.Portal.Props) {
  const container = usePortalContainer();
  return <MenuPrimitive.Portal data-slot="dropdown-menu-portal" container={container} {...props} />;
}

function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuContent({
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  anchor,
  collisionPadding,
  collisionAvoidance,
  sheet = false,
  onSheetDismiss,
  className,
  children,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<
    MenuPrimitive.Positioner.Props,
    | "align"
    | "alignOffset"
    | "side"
    | "sideOffset"
    | "anchor"
    | "collisionPadding"
    | "collisionAvoidance"
  > & {
    /**
     * Shows the menu as a sheet at the window's foot, for a phone: its submenus are pages
     * of it, and it stands where it does whatever it was opened from.
     */
    sheet?: boolean;
    /** The sheet was dragged down to be rid of it: whoever opened it closes it. */
    onSheetDismiss?: () => void;
  }) {
  const container = usePortalContainer();
  if (sheet) {
    return (
      <MenuPrimitive.Portal container={container}>
        <MenuPrimitive.Backdrop
          data-slot="dropdown-menu-sheet-overlay"
          className="aperture:fixed aperture:inset-0 aperture:z-50 aperture:bg-black/30 aperture:transition-opacity aperture:duration-200 aperture:data-ending-style:opacity-0 aperture:data-starting-style:opacity-0"
        />
        <MenuPrimitive.Positioner
          data-menu-sheet=""
          positionMethod="fixed"
          className={cn(
            SHEET_PLACE,
            "aperture:shadow-lg aperture:ring-1 aperture:ring-foreground/10",
          )}
        >
          <MenuPrimitive.Popup
            data-slot="dropdown-menu-content"
            className={cn(
              SHEET_PAGE,
              "aperture:transition-transform aperture:duration-300 aperture:ease-[cubic-bezier(0.32,0.72,0,1)] aperture:data-ending-style:translate-y-full aperture:data-starting-style:translate-y-full aperture:motion-reduce:duration-0",
              className,
            )}
            {...props}
          >
            <SheetContext.Provider value>
              <SheetGrip onDismiss={onSheetDismiss} />
              {children}
            </SheetContext.Provider>
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    );
  }
  return (
    <MenuPrimitive.Portal container={container}>
      <MenuPrimitive.Positioner
        className="aperture:isolate aperture:z-50 aperture:outline-none"
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        // A menu without a trigger, such as one shown where a click was, is told its place.
        anchor={anchor}
        collisionPadding={collisionPadding}
        collisionAvoidance={collisionAvoidance}
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            "aperture:z-50 aperture:max-h-(--available-height) aperture:w-(--anchor-width) aperture:min-w-32 aperture:origin-(--transform-origin) aperture:overflow-x-hidden aperture:overflow-y-auto aperture:rounded-lg aperture:bg-popover aperture:p-1 aperture:text-popover-foreground aperture:shadow-md aperture:ring-1 aperture:ring-foreground/10 aperture:duration-100 aperture:outline-none aperture:data-open:animate-in aperture:data-open:fade-in-0 aperture:data-closed:animate-out aperture:data-closed:overflow-hidden aperture:data-closed:fade-out-0",
            className,
          )}
          {...props}
        >
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function DropdownMenuGroup({ ...props }: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<"div"> & {
  inset?: boolean;
}) {
  const sheet = React.useContext(SheetContext);
  return (
    <div
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        "aperture:px-1.5 aperture:py-1 aperture:text-xs aperture:font-medium aperture:text-muted-foreground aperture:data-inset:pl-7",
        sheet && "aperture:px-3 aperture:pt-3",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  const sheet = React.useContext(SheetContext);
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "aperture:group/dropdown-menu-item aperture:relative aperture:flex aperture:cursor-default aperture:items-center aperture:gap-1.5 aperture:rounded-md aperture:px-1.5 aperture:py-1 aperture:text-sm aperture:outline-hidden aperture:select-none aperture:data-highlighted:bg-accent aperture:data-highlighted:text-accent-foreground aperture:not-data-[variant=destructive]:data-highlighted:**:[svg]:text-accent-foreground aperture:data-inset:pl-7 aperture:data-[variant=destructive]:text-destructive aperture:data-[variant=destructive]:data-highlighted:bg-destructive/10 aperture:data-[variant=destructive]:data-highlighted:text-destructive aperture:dark:data-[variant=destructive]:data-highlighted:bg-destructive/20 aperture:data-disabled:pointer-events-none aperture:data-disabled:opacity-50 aperture:[&_svg]:pointer-events-none aperture:[&_svg]:shrink-0 aperture:[&_svg:not([class*='size-'])]:size-4 aperture:data-[variant=destructive]:*:[svg]:text-destructive",
        sheet && SHEET_ROW,
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSub({ ...props }: MenuPrimitive.SubmenuRoot.Props) {
  const sheet = React.useContext(SheetContext);
  const [open, setOpen] = React.useState(false);
  const trigger = React.useRef<HTMLElement | null>(null);
  const sub = React.useMemo(() => ({ close: () => setOpen(false), trigger }), []);
  if (!sheet) {
    return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />;
  }
  // Open for as long as its page is not left: nothing hovers on a phone to close it.
  return (
    <SheetSubContext.Provider value={sub}>
      <MenuPrimitive.SubmenuRoot
        data-slot="dropdown-menu-sub"
        open={open}
        onOpenChange={setOpen}
        {...props}
      />
    </SheetSubContext.Provider>
  );
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props & {
  inset?: boolean;
}) {
  const sheet = React.useContext(SheetContext);
  return (
    <MenuPrimitive.SubmenuTrigger
      ref={React.useContext(SheetSubContext)?.trigger}
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "aperture:flex aperture:cursor-default aperture:items-center aperture:gap-1.5 aperture:rounded-md aperture:px-1.5 aperture:py-1 aperture:text-sm aperture:outline-hidden aperture:select-none aperture:data-highlighted:bg-accent aperture:data-highlighted:text-accent-foreground aperture:not-data-[variant=destructive]:data-highlighted:**:[svg]:text-accent-foreground aperture:data-inset:pl-7 aperture:data-popup-open:bg-accent aperture:data-popup-open:text-accent-foreground aperture:data-open:bg-accent aperture:data-open:text-accent-foreground aperture:[&_svg]:pointer-events-none aperture:[&_svg]:shrink-0 aperture:[&_svg:not([class*='size-'])]:size-4",
        sheet && SHEET_ROW,
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="aperture:ml-auto" />
    </MenuPrimitive.SubmenuTrigger>
  );
}

function DropdownMenuSubContent({
  align = "start",
  alignOffset = -3,
  side = "right",
  sideOffset = 0,
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuContent>) {
  const sheet = React.useContext(SheetContext);
  const sub = React.useContext(SheetSubContext);
  const container = usePortalContainer();
  // What its page is called: what opens it says, by the part of it that names it where
  // it says more than that.
  const [title, setTitle] = React.useState("");
  const named = React.useCallback(
    (element: HTMLElement | null) => {
      const opener = sub?.trigger.current;
      if (element !== null && opener != null) {
        const names = opener.querySelector("[data-menu-title]") ?? opener;
        setTitle((names.textContent ?? "").trim());
      }
    },
    [sub],
  );
  if (sheet && sub !== undefined) {
    const {
      anchor: _anchor,
      collisionPadding: _padding,
      collisionAvoidance: _avoidance,
      sheet: _sheet,
      onSheetDismiss: _dismiss,
      ...page
    } = props;
    return (
      <MenuPrimitive.Portal container={container}>
        <MenuPrimitive.Positioner
          positionMethod="fixed"
          className={cn(SHEET_PLACE, "aperture:pointer-events-none")}
        >
          <MenuPrimitive.Popup
            ref={named}
            data-slot="dropdown-menu-sub-content"
            data-menu-sheet-page={title}
            className={cn(
              SHEET_PAGE,
              "aperture:pointer-events-auto aperture:transition-transform aperture:duration-300 aperture:ease-[cubic-bezier(0.32,0.72,0,1)] aperture:data-ending-style:translate-x-full aperture:data-starting-style:translate-x-full aperture:motion-reduce:duration-0",
            )}
            {...page}
          >
            <div className="aperture:sticky aperture:top-0 aperture:z-10 aperture:flex aperture:h-13 aperture:shrink-0 aperture:items-center aperture:bg-popover">
              <button
                type="button"
                data-menu-sheet-back=""
                aria-label="Back"
                className="aperture:flex aperture:size-11 aperture:shrink-0 aperture:items-center aperture:justify-center aperture:rounded-full aperture:outline-none aperture:focus-visible:ring-3 aperture:focus-visible:ring-ring/50 aperture:active:bg-accent"
                onClick={sub.close}
              >
                <ChevronLeftIcon className="aperture:size-5" />
              </button>
              <span className="aperture:min-w-0 aperture:flex-1 aperture:truncate aperture:pr-11 aperture:text-center aperture:text-base aperture:font-medium">
                {title}
              </span>
            </div>
            {children}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    );
  }
  return (
    <DropdownMenuContent
      data-slot="dropdown-menu-sub-content"
      className={cn(
        "aperture:w-auto aperture:min-w-[96px] aperture:rounded-lg aperture:bg-popover aperture:p-1 aperture:text-popover-foreground aperture:shadow-lg aperture:ring-1 aperture:ring-foreground/10 aperture:duration-100 aperture:data-open:animate-in aperture:data-open:fade-in-0 aperture:data-closed:animate-out aperture:data-closed:fade-out-0",
        className,
      )}
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      {...props}
    >
      {children}
    </DropdownMenuContent>
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  ...props
}: MenuPrimitive.CheckboxItem.Props & {
  inset?: boolean;
}) {
  const sheet = React.useContext(SheetContext);
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      data-inset={inset}
      className={cn(
        "aperture:relative aperture:flex aperture:cursor-default aperture:items-center aperture:gap-1.5 aperture:rounded-md aperture:py-1 aperture:pr-8 aperture:pl-1.5 aperture:text-sm aperture:outline-hidden aperture:select-none aperture:data-highlighted:bg-accent aperture:data-highlighted:text-accent-foreground aperture:data-highlighted:**:[svg]:text-accent-foreground aperture:data-inset:pl-7 aperture:data-disabled:pointer-events-none aperture:data-disabled:opacity-50 aperture:[&_svg]:pointer-events-none aperture:[&_svg]:shrink-0 aperture:[&_svg:not([class*='size-'])]:size-4",
        sheet && SHEET_MARKED_ROW,
        className,
      )}
      checked={checked}
      {...props}
    >
      <span
        className={cn(
          "aperture:pointer-events-none aperture:absolute aperture:right-2 aperture:flex aperture:items-center aperture:justify-center",
          sheet && "aperture:right-3",
        )}
        data-slot="dropdown-menu-checkbox-item-indicator"
      >
        <MenuPrimitive.CheckboxItemIndicator>
          <CheckIcon />
        </MenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </MenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuRadioGroup({ ...props }: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}

function DropdownMenuRadioItem({
  className,
  children,
  inset,
  ...props
}: MenuPrimitive.RadioItem.Props & {
  inset?: boolean;
}) {
  const sheet = React.useContext(SheetContext);
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      data-inset={inset}
      className={cn(
        "aperture:relative aperture:flex aperture:cursor-default aperture:items-center aperture:gap-1.5 aperture:rounded-md aperture:py-1 aperture:pr-8 aperture:pl-1.5 aperture:text-sm aperture:outline-hidden aperture:select-none aperture:data-highlighted:bg-accent aperture:data-highlighted:text-accent-foreground aperture:data-highlighted:**:[svg]:text-accent-foreground aperture:data-inset:pl-7 aperture:data-disabled:pointer-events-none aperture:data-disabled:opacity-50 aperture:[&_svg]:pointer-events-none aperture:[&_svg]:shrink-0 aperture:[&_svg:not([class*='size-'])]:size-4",
        sheet && SHEET_MARKED_ROW,
        className,
      )}
      {...props}
    >
      <span
        className={cn(
          "aperture:pointer-events-none aperture:absolute aperture:right-2 aperture:flex aperture:items-center aperture:justify-center",
          sheet && "aperture:right-3",
        )}
        data-slot="dropdown-menu-radio-item-indicator"
      >
        <MenuPrimitive.RadioItemIndicator>
          <CheckIcon />
        </MenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  );
}

function DropdownMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("aperture:-mx-1 aperture:my-1 aperture:h-px aperture:bg-border", className)}
      {...props}
    />
  );
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(
        "aperture:ml-auto aperture:text-xs aperture:tracking-widest aperture:text-muted-foreground aperture:group-focus/dropdown-menu-item:text-accent-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};
