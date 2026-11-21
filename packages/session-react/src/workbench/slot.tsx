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
} satisfies Record<string, ComponentType<{ children?: ReactNode }>>;

/**
 * What is contributed to a menu, group by group. A line parts the groups that show
 * something; it is drawn by the stylesheet, which alone knows which do.
 */
export function WorkbenchMenuSlot({
  name,
  kind = "dropdown",
  ...props
}: SlotProps & { readonly kind?: keyof typeof MENU_GROUPS }) {
  const { contributions } = useWorkbench();
  const Group = MENU_GROUPS[kind];
  return groupContributions(contributions, name).map(([group, items]) => (
    <Group key={group} data-workbench-menu-group={group}>
      {items.map((one) => (
        <one.component key={one.id} {...props} />
      ))}
    </Group>
  ));
}
