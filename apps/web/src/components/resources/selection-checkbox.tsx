import { useRef } from "react";
import { Checkbox } from "@aperture-browser/ui/components/checkbox";
import { cn } from "@aperture-browser/ui/utils";

export interface ItemSelection {
  readonly selected: boolean;
  /** Something is selected, so every item shows its checkbox, not only the hovered one. */
  readonly active: boolean;
  readonly onChange: (checked: boolean, shiftKey: boolean) => void;
}

/**
 * The checkbox that selects a card or row for bulk actions. Hidden until the item is hovered,
 * unless a selection is in progress. Shift extends the selection from the last clicked item.
 */
export function SelectionCheckbox({
  selection,
  label,
  className,
}: {
  selection: ItemSelection;
  label: string;
  className?: string;
}) {
  const shiftKey = useRef(false);
  return (
    <span
      className={cn(
        "aperture:flex aperture:w-4 aperture:shrink-0 aperture:overflow-hidden aperture:transition-[width,margin,opacity] aperture:duration-150",
        // Collapsed until the item is hovered or focused, so titles line up without it.
        !selection.active &&
          "aperture:-mr-2 aperture:w-0 aperture:opacity-0 aperture:group-focus-within/item:mr-0 aperture:group-focus-within/item:w-4 aperture:group-focus-within/item:opacity-100 aperture:group-hover/item:mr-0 aperture:group-hover/item:w-4 aperture:group-hover/item:opacity-100",
        className,
      )}
    >
      <Checkbox
        aria-label={label}
        checked={selection.selected}
        onMouseDown={(event) => {
          if (event.shiftKey) {
            event.preventDefault();
          }
        }}
        onClick={(event) => {
          shiftKey.current = event.shiftKey;
        }}
        onCheckedChange={(checked) => {
          selection.onChange(checked, shiftKey.current);
          shiftKey.current = false;
        }}
      />
    </span>
  );
}
