import { useRef, type ReactNode } from "react";
import { Checkbox } from "@aperture-browser/ui/components/checkbox";
import { cn } from "@aperture-browser/ui/utils";

export interface ItemSelection {
  readonly selected: boolean;
  /** Something is selected, so clicking an item's title adds it instead of doing nothing. */
  readonly active: boolean;
  readonly onChange: (checked: boolean, shiftKey: boolean) => void;
}

/**
 * Selects a card or row for bulk actions. The checkbox and the item's title form one label,
 * so the whole title is a target. Shift extends the selection from the last clicked item.
 */
export function SelectionLabel({
  selection,
  label,
  className,
  children,
}: {
  selection: ItemSelection;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const shiftKey = useRef(false);
  return (
    <label
      className={cn(
        "aperture:-m-1 aperture:flex aperture:min-w-0 aperture:flex-1 aperture:cursor-pointer aperture:items-center aperture:gap-2 aperture:rounded-md aperture:p-1 aperture:select-none",
        className,
      )}
      onMouseDown={(event) => {
        // Shift+click would otherwise select the text between the two items.
        if (event.shiftKey) {
          event.preventDefault();
        }
      }}
      onClickCapture={(event) => {
        shiftKey.current = event.shiftKey;
      }}
    >
      <Checkbox
        aria-label={label}
        checked={selection.selected}
        className="aperture:size-4.5 aperture:border-foreground/30"
        onCheckedChange={(checked) => {
          selection.onChange(checked, shiftKey.current);
          shiftKey.current = false;
        }}
      />
      {children}
    </label>
  );
}
