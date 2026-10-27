import type { LucideIcon } from "lucide-react";
import type { ReactElement } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@aperture-browser/ui/components/context-menu";
import { Button } from "@aperture-browser/ui/components/button";

/** One action on the current selection, shown in the floating bar and the context menu. */
export interface BulkAction {
  readonly key: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** How many selected items it applies to; zero disables it. */
  readonly count: number;
  readonly destructive?: boolean;
  readonly run: () => void;
}

/** Right-clicking a selected item lists the actions for the whole selection. */
export function SelectionContextMenu({
  itemCount,
  actions,
  trigger,
}: {
  itemCount: number;
  actions: readonly BulkAction[];
  trigger: ReactElement;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger render={trigger} />
      <ContextMenuContent className="aperture:w-56">
        <ContextMenuGroup>
          <ContextMenuLabel>
            {itemCount} {itemCount === 1 ? "item" : "items"} selected
          </ContextMenuLabel>
        </ContextMenuGroup>
        <ContextMenuSeparator />
        {actions.map((action) => (
          <ContextMenuItem
            key={action.key}
            variant={action.destructive ? "destructive" : "default"}
            disabled={action.count === 0}
            onClick={action.run}
          >
            <action.icon />
            {action.label}
            {action.count > 0 && action.count !== itemCount ? (
              <span className="aperture:ml-auto aperture:text-xs aperture:text-muted-foreground">
                {action.count}
              </span>
            ) : null}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The same actions as buttons for the floating selection bar. */
export function BulkActionButtons({ actions }: { actions: readonly BulkAction[] }) {
  return actions.map((action) => (
    <Button
      key={action.key}
      type="button"
      variant={action.destructive ? "destructive" : "ghost"}
      size="sm"
      disabled={action.count === 0}
      onClick={action.run}
    >
      <action.icon data-icon="inline-start" />
      {action.label}
    </Button>
  ));
}
