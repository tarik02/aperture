import { useRef } from "react";
import { Checkbox } from "@aperture-browser/ui/components/checkbox";
import { TableCell, TableHead } from "@aperture-browser/ui/components/table";
import type { RowSelectionDragControls } from "#/hooks/use-row-selection.ts";

export function TableSelectAll({
  allSelected,
  someSelected,
  disabled,
  onCheckedChange,
}: {
  allSelected: boolean;
  someSelected: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <TableHead className="aperture:w-10 aperture:px-0!">
      <div className="aperture:flex aperture:justify-center">
        <Checkbox
          aria-label="Select all loaded rows"
          checked={allSelected}
          indeterminate={someSelected}
          disabled={disabled}
          onCheckedChange={onCheckedChange}
        />
      </div>
    </TableHead>
  );
}

/**
 * The checkbox cell of a row. Pressing it starts a drag that selects or clears every row the
 * pointer passes over; Shift extends from the last clicked row.
 */
export function TableSelectRow({
  rowId,
  checked,
  label,
  disabled,
  drag,
  onCheckedChange,
}: {
  rowId: string;
  checked: boolean;
  label: string;
  disabled?: boolean;
  drag: RowSelectionDragControls;
  onCheckedChange: (checked: boolean, shiftKey: boolean) => void;
}) {
  const shiftKeyRef = useRef(false);
  // The press already toggled the row; the click that follows it must not toggle it back.
  const suppressPointerClickRef = useRef(false);

  return (
    <TableCell
      className="aperture:w-10 aperture:touch-none aperture:px-0! aperture:select-none"
      onClick={(event) => event.stopPropagation()}
      onClickCapture={(event) => {
        if (event.detail > 0 && suppressPointerClickRef.current) {
          event.preventDefault();
          event.stopPropagation();
          suppressPointerClickRef.current = false;
        }
      }}
      onPointerDown={(event) => {
        if (disabled || event.button !== 0) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        suppressPointerClickRef.current = true;
        drag.start(rowId, !checked, event.pointerId, event.shiftKey);
      }}
      onPointerEnter={(event) => drag.enter(rowId, event.pointerId)}
      onPointerMove={(event) => {
        if ((event.buttons & 1) === 1) {
          drag.enter(rowId, event.pointerId);
        }
      }}
      onPointerUp={(event) => drag.enter(rowId, event.pointerId)}
    >
      <div className="aperture:flex aperture:cursor-pointer aperture:justify-center">
        <Checkbox
          aria-label={label}
          checked={checked}
          disabled={disabled}
          onMouseDown={(event) => {
            if (event.shiftKey) {
              event.preventDefault();
            }
          }}
          onClick={(event) => {
            shiftKeyRef.current = event.shiftKey;
          }}
          onKeyDown={(event) => {
            shiftKeyRef.current = event.shiftKey;
          }}
          onCheckedChange={(nextChecked) => {
            onCheckedChange(nextChecked, shiftKeyRef.current);
            shiftKeyRef.current = false;
          }}
        />
      </div>
    </TableCell>
  );
}
