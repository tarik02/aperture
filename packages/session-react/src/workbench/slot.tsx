import type { ComponentType, ReactNode } from "react";
import { ContextMenuGroup } from "@aperture-browser/ui/components/context-menu";
import { DropdownMenuGroup } from "@aperture-browser/ui/components/dropdown-menu";
import {
  groupContributions,
  type WorkbenchSlotName as SlotName,
  type WorkbenchSlotProps,
} from "./contributions.ts";
import { useWorkbench } from "./context.tsx";

export interface SlotProps extends WorkbenchSlotProps {
  readonly name: SlotName;
}

/** What is contributed to a slot, one after the other. */
export function WorkbenchSlot({ name, ...props }: SlotProps) {
  const { contributions } = useWorkbench();
  return groupContributions(contributions, name).flatMap(([, group]) =>
    group.map((one) => <one.component key={one.id} {...props} />),
  );
}

const MENU_GROUPS = {
  dropdown: DropdownMenuGroup,
  context: ContextMenuGroup,
} satisfies Record<string, ComponentType<{ children?: ReactNode; className?: string }>>;

/**
 * A line before a group that shows something and comes after another that does: a group
 * whose contributions render nothing is empty, and takes no line. It is the group's own
 * classes, so that every page that has the menu has its lines, whichever stylesheet it is
 * built with.
 */
const PARTED =
  "aperture:[[data-workbench-menu-group]:not(:empty)~&:not(:empty)]:before:-mx-1 aperture:[[data-workbench-menu-group]:not(:empty)~&:not(:empty)]:before:my-1 aperture:[[data-workbench-menu-group]:not(:empty)~&:not(:empty)]:before:block aperture:[[data-workbench-menu-group]:not(:empty)~&:not(:empty)]:before:h-px aperture:[[data-workbench-menu-group]:not(:empty)~&:not(:empty)]:before:bg-border";

/** What is contributed to a menu, group by group, with a line between the groups. */
export function WorkbenchMenuSlot({
  name,
  kind = "dropdown",
  ...props
}: SlotProps & { readonly kind?: keyof typeof MENU_GROUPS }) {
  const { contributions } = useWorkbench();
  const Group = MENU_GROUPS[kind];
  return groupContributions(contributions, name).map(([group, items]) => (
    <Group key={group} data-workbench-menu-group={group} className={PARTED}>
      {items.map((one) => (
        <one.component key={one.id} {...props} />
      ))}
    </Group>
  ));
}
