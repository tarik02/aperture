import { Button } from "@aperture-browser/ui/components/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@aperture-browser/ui/components/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@aperture-browser/ui/components/dropdown-menu";
import { EllipsisVertical, type LucideIcon } from "lucide-react";
import { Fragment } from "react";
import { type Guarded, useAccess } from "#/features/auth/access.ts";
import { usePhone } from "#/lib/use-phone.ts";

/** One thing done with what a row shows, as its button and its menus offer it. */
export interface RowAction extends Guarded {
  readonly key: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
  /** A line before it, where another kind of thing begins. */
  readonly parted?: boolean;
  /**
   * Whether it stands in the row as a button of its own where there is room: with its
   * name, or as its icon alone. On a phone everything is in the menu.
   */
  readonly shown?: "button" | "icon";
}

const MENU = "aperture:w-auto aperture:min-w-44 aperture:whitespace-nowrap";

/**
 * What is done with a row, at its end: the buttons that have room there, and a menu of the
 * rest. On a phone the menu has them all, and is all there is.
 */
export function RowActions({
  actions: all,
  label = "Actions",
}: {
  actions: ReadonlyArray<RowAction>;
  label?: string;
}) {
  const phone = usePhone();
  const actions = all.filter(useAccess().offers);
  if (actions.length === 0) {
    return null;
  }
  // What has a button of its own is not in the menu as well.
  const listed = phone ? actions : actions.filter((action) => action.shown === undefined);
  return (
    <div className="aperture:flex aperture:items-center aperture:justify-end aperture:gap-1">
      {actions.map((action) =>
        action.shown === undefined ? null : (
          <Button
            key={action.key}
            size={action.shown === "icon" ? "icon-sm" : "sm"}
            variant={action.shown === "icon" ? "ghost" : "outline"}
            aria-label={action.shown === "icon" ? action.label : undefined}
            data-console-row-action={action.key}
            disabled={action.disabled === true}
            className="aperture:max-sm:hidden"
            onClick={action.onSelect}
          >
            <action.icon />
            {action.shown === "icon" ? null : action.label}
          </Button>
        ),
      )}
      {listed.length === 0 ? null : (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button size="icon-sm" variant="ghost" aria-label={label} data-console-row-actions />
            }
          >
            <EllipsisVertical />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className={MENU}>
            {listed.map((action, index) => (
              <Fragment key={action.key}>
                {action.parted === true && index > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem
                  data-console-row-action={action.key}
                  disabled={action.disabled === true}
                  variant={action.destructive === true ? "destructive" : "default"}
                  onClick={action.onSelect}
                >
                  <action.icon />
                  {action.label}
                </DropdownMenuItem>
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

/** The same actions where a right click or a long press was, on the row it wraps. */
export function RowContextMenu({
  actions: all,
  children,
}: {
  actions: ReadonlyArray<RowAction>;
  children: React.ReactElement;
}) {
  const actions = all.filter(useAccess().offers);
  if (actions.length === 0) {
    return children;
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger render={children} />
      <ContextMenuContent data-console-row-context className={MENU}>
        {actions.map((action, index) => (
          <Fragment key={action.key}>
            {action.parted === true && index > 0 ? <ContextMenuSeparator /> : null}
            <ContextMenuItem
              disabled={action.disabled === true}
              variant={action.destructive === true ? "destructive" : "default"}
              onClick={action.onSelect}
            >
              <action.icon />
              {action.label}
            </ContextMenuItem>
          </Fragment>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
