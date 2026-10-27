import { useCallback, useEffect, useMemo, useRef } from "react";
import { selectTableSelection, useTableSelectionStore } from "#/stores/table-selection.ts";

interface RowDragState {
  lastIndex: number;
  readonly pointerId: number;
  readonly select: boolean;
  readonly visitedIds: Set<string>;
}

export interface RowSelectionDragControls {
  readonly start: (rowId: string, select: boolean, pointerId: number, shiftKey: boolean) => void;
  readonly enter: (rowId: string, pointerId: number) => void;
}

/**
 * Checkbox selection for one table, kept per `tableKey` across navigation. Shift+click selects
 * the range from the last clicked row, and dragging over the checkbox column selects or clears
 * every row the pointer passes.
 */
export function useRowSelection<T>({
  tableKey,
  rows,
  getId,
}: {
  tableKey: string;
  /** Rows in display order. */
  rows: readonly T[];
  getId: (row: T) => string;
}) {
  const selection = useTableSelectionStore(selectTableSelection(tableKey));
  const setRows = useTableSelectionStore((state) => state.setRows);
  const clearSelection = useTableSelectionStore((state) => state.clear);
  const refresh = useTableSelectionStore((state) => state.refresh);
  const dragRef = useRef<RowDragState | null>(null);

  const orderedIds = useMemo(() => rows.map(getId), [getId, rows]);
  const rowsById = useMemo(() => new Map(rows.map((row) => [getId(row), row])), [getId, rows]);

  useEffect(() => {
    refresh(tableKey, rowsById);
  }, [refresh, rowsById, tableKey]);

  useEffect(() => {
    const finishDrag = (event: PointerEvent) => {
      if (dragRef.current?.pointerId === event.pointerId) {
        dragRef.current = null;
      }
    };
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", finishDrag);
    return () => {
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", finishDrag);
    };
  }, []);

  const entries = useCallback(
    (ids: readonly string[]) =>
      ids.flatMap((id) => {
        const row = rowsById.get(id);
        return row === undefined ? [] : [[id, row] as const];
      }),
    [rowsById],
  );

  const toggleOne = useCallback(
    (rowId: string, checked: boolean, shiftKey: boolean) => {
      const anchor = useTableSelectionStore.getState().anchors[tableKey] ?? null;
      const anchorIndex = anchor === null ? -1 : orderedIds.indexOf(anchor);
      const rowIndex = orderedIds.indexOf(rowId);
      const ids =
        shiftKey && anchorIndex >= 0 && rowIndex >= 0
          ? orderedIds.slice(Math.min(anchorIndex, rowIndex), Math.max(anchorIndex, rowIndex) + 1)
          : [rowId];
      setRows(tableKey, entries(ids), checked, rowId);
    },
    [entries, orderedIds, setRows, tableKey],
  );

  const drag = useMemo<RowSelectionDragControls>(
    () => ({
      start: (rowId, select, pointerId, shiftKey) => {
        const rowIndex = orderedIds.indexOf(rowId);
        if (rowIndex < 0) {
          return;
        }
        dragRef.current = { lastIndex: rowIndex, pointerId, select, visitedIds: new Set([rowId]) };
        toggleOne(rowId, select, shiftKey);
      },
      enter: (rowId, pointerId) => {
        const current = dragRef.current;
        const rowIndex = orderedIds.indexOf(rowId);
        if (current === null || current.pointerId !== pointerId || rowIndex < 0) {
          return;
        }
        // Fast pointer moves skip rows; fill in everything between the last row and this one.
        const skipped = orderedIds
          .slice(Math.min(current.lastIndex, rowIndex), Math.max(current.lastIndex, rowIndex) + 1)
          .filter((id) => !current.visitedIds.has(id));
        for (const id of skipped) {
          current.visitedIds.add(id);
        }
        current.lastIndex = rowIndex;
        if (skipped.length > 0) {
          setRows(tableKey, entries(skipped), current.select);
        }
      },
    }),
    [entries, orderedIds, setRows, tableKey, toggleOne],
  );

  const selectedCount = Object.keys(selection).length;
  const visibleSelected = orderedIds.filter((id) => id in selection).length;
  const allSelected = orderedIds.length > 0 && visibleSelected === orderedIds.length;

  return {
    selectedItems: useMemo(() => Object.values(selection) as T[], [selection]),
    selectedCount,
    isSelected: (id: string) => id in selection,
    allSelected,
    someSelected: visibleSelected > 0 && !allSelected,
    toggleOne,
    toggleAll: (checked: boolean) => setRows(tableKey, entries(orderedIds), checked, null),
    remove: (id: string) => setRows(tableKey, [[id, undefined]], false),
    clear: () => clearSelection(tableKey),
    drag,
  };
}
