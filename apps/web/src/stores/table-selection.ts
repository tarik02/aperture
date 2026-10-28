import { create } from "zustand";

type Selection = Readonly<Record<string, unknown>>;

interface TableSelectionStore {
  /** Selected rows per table, by id. Rows are kept so batch actions still see filtered-out ones. */
  readonly selections: Readonly<Record<string, Selection>>;
  /** The row a Shift+click range starts from, per table. */
  readonly anchors: Readonly<Record<string, string | null>>;
  readonly setRows: (
    tableKey: string,
    rows: ReadonlyArray<readonly [id: string, row: unknown]>,
    checked: boolean,
    anchor?: string | null,
  ) => void;
  readonly clear: (tableKey: string) => void;
  readonly refresh: (tableKey: string, rows: ReadonlyMap<string, unknown>) => void;
}

const emptySelection: Selection = {};

export const useTableSelectionStore = create<TableSelectionStore>()((set) => ({
  selections: {},
  anchors: {},
  setRows: (tableKey, rows, checked, anchor) =>
    set((state) => {
      const selection: Record<string, unknown> = { ...state.selections[tableKey] };
      for (const [id, row] of rows) {
        if (checked) {
          selection[id] = row;
        } else {
          delete selection[id];
        }
      }
      return {
        selections: { ...state.selections, [tableKey]: selection },
        anchors: anchor === undefined ? state.anchors : { ...state.anchors, [tableKey]: anchor },
      };
    }),
  clear: (tableKey) =>
    set((state) => ({
      selections: { ...state.selections, [tableKey]: emptySelection },
      anchors: { ...state.anchors, [tableKey]: null },
    })),
  // Keeps selected rows current when a refetch returns newer versions of them.
  refresh: (tableKey, rows) =>
    set((state) => {
      const current = state.selections[tableKey];
      if (!current) {
        return state;
      }
      let changed = false;
      const next: Record<string, unknown> = { ...current };
      for (const id of Object.keys(current)) {
        const row = rows.get(id);
        if (row !== undefined && row !== current[id]) {
          next[id] = row;
          changed = true;
        }
      }
      return changed ? { selections: { ...state.selections, [tableKey]: next } } : state;
    }),
}));

export function selectTableSelection(tableKey: string) {
  return (state: TableSelectionStore) => state.selections[tableKey] ?? emptySelection;
}
