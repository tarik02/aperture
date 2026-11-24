"use client";

import * as React from "react";
import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";

import { cn } from "../utils.ts";
import { ChevronLeftIcon, ChevronRightIcon, CheckIcon } from "lucide-react";
import { usePortalContainer } from "../portal.tsx";
import {
  Drawer,
  DrawerFrame,
  DrawerHandle,
  drawerPopupClassName,
  type DrawerSide,
} from "./drawer.tsx";

/**
 * Whether the menu is a sheet, as a phone has it: its submenus are then pages that slide
 * in over it, each with the way back, in place of menus beside it.
 */
const SheetContext = React.createContext(false);

/** A menu that is a sheet, for what it is made of. */
const SheetMenuContext = React.createContext<
  | {
      readonly side: DrawerSide;
      readonly open: boolean;
      readonly close: () => void;
      /** The sheet has gone from the window: the menu is then closed for itself as well. */
      readonly gone: () => void;
    }
  | undefined
>(undefined);

/** Where the pages of a sheet are laid, over what the sheet shows first. */
const SheetPagesContext = React.createContext<HTMLElement | null>(null);

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
 * How much of the window's height a sheet at its foot takes: as it opens, low, where a
 * thumb reaches all of it, and dragged up. The sheet is as tall for every page of it.
 */
const SHEET_HEIGHTS = [0.5, 1];

/** A menu laid in a sheet in place of beside what opened it, whatever its anchor says. */
const SHEET_PLACED =
  "aperture:static! aperture:size-full aperture:min-h-0 aperture:transform-none! aperture:outline-none";

/** A sheet's page, which scrolls within itself. */
const SHEET_PAGE =
  "aperture:flex aperture:size-full aperture:min-h-0 aperture:flex-col aperture:overflow-hidden aperture:rounded-[inherit] aperture:bg-popover aperture:text-popover-foreground aperture:outline-none";

/** What scrolls in a sheet's page. */
const SHEET_SCROLLS =
  "aperture:min-h-0 aperture:flex-1 aperture:touch-auto aperture:overflow-x-hidden aperture:overflow-y-auto aperture:overscroll-contain aperture:pr-[max(0.5rem,env(safe-area-inset-right))] aperture:pb-[max(0.5rem,env(safe-area-inset-bottom))] aperture:pl-[max(0.5rem,env(safe-area-inset-left))]";

/** A sheet at a side of the window has that side's inset already. */
const SHEET_SCROLLS_SIDE = {
  bottom: "",
  left: "aperture:pl-2",
  right: "aperture:pr-2",
} as const;

/** A sheet's row: as tall as a finger needs, and written larger than a menu's. */
const SHEET_ROW =
  "aperture:min-h-11 aperture:gap-3 aperture:rounded-lg aperture:px-3 aperture:text-[0.9375rem] aperture:[&_svg:not([class*='size-'])]:size-5";

/** A sheet's row that is checked or chosen, with the mark of that at its end. */
const SHEET_MARKED_ROW = cn(SHEET_ROW, "aperture:pr-10");

type DropdownMenuProps = Omit<MenuPrimitive.Root.Props, "onOpenChange"> & {
  sheet?: DrawerSide | false;
  /** Told without what changed it where a sheet was dragged away. */
  onOpenChange?: (open: boolean, details?: MenuPrimitive.Root.ChangeEventDetails) => void;
};

/**
 * A menu. One that is a `sheet` is shown as a sheet that follows the finger, for a phone,
 * at the window's foot or at the side named: it is then opened and closed by whoever
 * shows it, and stays until the sheet has gone from the window.
 */
function DropdownMenu({ sheet = false, ...props }: DropdownMenuProps) {
  if (sheet === false) {
    return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
  }
  return <SheetMenu side={sheet} {...props} />;
}

function SheetMenu({
  side,
  open = false,
  onOpenChange,
  ...props
}: Omit<DropdownMenuProps, "sheet"> & { side: DrawerSide }) {
  const [lingers, setLingers] = React.useState(open);
  if (open && !lingers) {
    setLingers(true);
  }
  const change = React.useRef(onOpenChange);
  change.current = onOpenChange;
  const menu = React.useMemo(
    () => ({
      side,
      open,
      close: () => change.current?.(false),
      gone: () => setLingers(false),
    }),
    [side, open],
  );
  return (
    <SheetMenuContext.Provider value={menu}>
      <MenuPrimitive.Root
        data-slot="dropdown-menu"
        // The sheet is what keeps the page behind it from being used.
        modal={false}
        open={open || lingers}
        onOpenChange={onOpenChange}
        {...props}
      />
    </SheetMenuContext.Provider>
  );
}

/** The menu as a sheet: what it holds scrolls, with its `footer` kept below that. */
function SheetMenuContent({
  footer,
  className,
  children,
  finalFocus,
  ...props
}: MenuPrimitive.Popup.Props & { footer?: React.ReactNode }) {
  const menu = React.useContext(SheetMenuContext);
  const container = usePortalContainer();
  const [pages, setPages] = React.useState<HTMLElement | null>(null);
  const [height, setHeight] = React.useState<number | string | null>(SHEET_HEIGHTS[0] ?? null);
  // It comes in from the window's edge, which it is not at before it is there.
  const [entered, setEntered] = React.useState(false);
  React.useEffect(() => setEntered(true), []);
  if (menu === undefined) {
    throw new Error("A menu's sheet is shown outside a menu that is a sheet");
  }
  const { side } = menu;
  const snaps = side === "bottom";

  return (
    <MenuPrimitive.Portal container={container}>
      <Drawer
        side={side}
        open={menu.open && entered}
        onOpenChange={(next) => {
          if (!next) {
            menu.close();
          }
        }}
        onOpenChangeComplete={(next) => {
          if (!next && !menu.open) {
            menu.gone();
          }
        }}
        // Its height is this one's to say from the first, also while it has none to be at.
        snapPoint={height}
        onSnapPointChange={setHeight}
        {...(snaps ? { snapPoints: SHEET_HEIGHTS } : {})}
      >
        <DrawerFrame>
          <DrawerPrimitive.Popup
            data-menu-sheet=""
            data-side={side}
            data-height={!snaps || height === SHEET_HEIGHTS[1] ? "full" : "part"}
            finalFocus={finalFocus}
            className={drawerPopupClassName(
              side,
              side === "bottom" ? "aperture:h-[min(40rem,100%)]" : undefined,
            )}
          >
            <MenuPrimitive.Positioner positionMethod="fixed" className={SHEET_PLACED}>
              <MenuPrimitive.Popup
                data-slot="dropdown-menu-content"
                finalFocus={finalFocus}
                className={cn(SHEET_PAGE, "aperture:relative", className)}
                {...props}
              >
                <SheetContext.Provider value>
                  <SheetPagesContext.Provider value={pages}>
                    <div
                      data-slot="dropdown-menu-sheet-grip"
                      className="aperture:flex aperture:h-6 aperture:shrink-0 aperture:items-start aperture:justify-center"
                    >
                      <DrawerHandle side={side} />
                    </div>
                    <DrawerPrimitive.Content
                      className={cn(SHEET_SCROLLS, SHEET_SCROLLS_SIDE[side])}
                    >
                      {children}
                    </DrawerPrimitive.Content>
                    {footer}
                  </SheetPagesContext.Provider>
                </SheetContext.Provider>
                <div
                  ref={setPages}
                  className="aperture:pointer-events-none aperture:absolute aperture:inset-0 aperture:overflow-hidden aperture:rounded-[inherit]"
                />
              </MenuPrimitive.Popup>
            </MenuPrimitive.Positioner>
          </DrawerPrimitive.Popup>
        </DrawerFrame>
      </Drawer>
    </MenuPrimitive.Portal>
  );
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
  footer,
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
    /** What a menu that is a sheet keeps below what scrolls in it. */
    footer?: React.ReactNode;
  }) {
  const container = usePortalContainer();
  if (React.useContext(SheetMenuContext) !== undefined) {
    return (
      <SheetMenuContent footer={footer} className={className} {...props}>
        {children}
      </SheetMenuContent>
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
      // A sheet's page is opened by a press: a pointer left over its row asks for nothing.
      {...(sheet ? { openOnHover: false } : {})}
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
  const pages = React.useContext(SheetPagesContext);
  const edge = React.useContext(SheetMenuContext)?.side ?? "bottom";
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
      footer: _footer,
      ...page
    } = props;
    return (
      <MenuPrimitive.Portal container={pages}>
        <MenuPrimitive.Positioner
          positionMethod="fixed"
          className="aperture:absolute! aperture:inset-0! aperture:transform-none! aperture:outline-none"
        >
          <MenuPrimitive.Popup
            ref={named}
            data-slot="dropdown-menu-sub-content"
            data-menu-sheet-page={title}
            className={cn(
              SHEET_PAGE,
              // A page that is on its way out takes no press: one meant for the row under it
              // would be a press beside the menu, which is rid of the menu.
              "aperture:pointer-events-auto aperture:transition-transform aperture:duration-300 aperture:ease-[cubic-bezier(0.32,0.72,0,1)] aperture:data-ending-style:pointer-events-none aperture:data-ending-style:translate-x-full aperture:data-starting-style:translate-x-full aperture:motion-reduce:duration-0",
            )}
            {...page}
          >
            <div className="aperture:flex aperture:h-13 aperture:shrink-0 aperture:items-center aperture:px-[max(0.5rem,env(safe-area-inset-left))]">
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
            <DrawerPrimitive.Content className={cn(SHEET_SCROLLS, SHEET_SCROLLS_SIDE[edge])}>
              {children}
            </DrawerPrimitive.Content>
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
