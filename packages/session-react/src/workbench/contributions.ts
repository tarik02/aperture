import type { ComponentType } from "react";
import type { Target } from "@aperture-browser/session-client";

/**
 * A place of the workbench that takes contributions.
 *
 * - `titlebar.start`, `titlebar.end`: beside the tab strip and the members.
 * - `toolbar.start`, `toolbar.end`: before the navigation buttons, and after the address.
 * - `toolbar.actions`: the buttons at the toolbar's end.
 * - `menu.browser`, `menu.picture`, `menu.recording`: the menus of those buttons.
 * - `menu.tab`: the menu of a right click on a tab, which is given as `target`.
 * - `menu.page`: the menu of a right click in the session.
 * - `viewport`: laid over the picture.
 *
 * On a phone the workbench is the picture with a bar below it: the toolbar's slots are in
 * the bar, the menus are reached from the bar's menu, and the title bar's slots are shown
 * nowhere. What is contributed there for a phone as well has a place in `menu.browser`.
 */
export type WorkbenchSlotName =
  | "titlebar.start"
  | "titlebar.end"
  | "toolbar.start"
  | "toolbar.end"
  | "toolbar.actions"
  | "menu.browser"
  | "menu.picture"
  | "menu.recording"
  | "menu.tab"
  | "menu.page"
  | "viewport";

export interface WorkbenchSlotProps {
  /** The tab the menu is of, in `menu.tab`. */
  readonly target?: Target | undefined;
}

/**
 * One thing in one place of the workbench. Everything the workbench shows in its slots is
 * a contribution, its own included: one with the id of another takes its place.
 */
export interface WorkbenchContribution {
  readonly id: string;
  readonly slot: WorkbenchSlotName;
  /**
   * In a menu, the contributions of one group stand together, apart from the other groups.
   * Groups come in the order of their first contribution.
   */
  readonly group?: string | undefined;
  /** Lower comes first; the workbench's own are a hundred apart. */
  readonly order?: number | undefined;
  /**
   * What is shown. A menu's contribution renders items of the menu's kind: of a dropdown
   * menu, and in `menu.tab` of a context menu. Rendering nothing leaves no trace.
   */
  readonly component: ComponentType<WorkbenchSlotProps>;
}

/**
 * The contributions an embedder gives: more of them, each replacing the one of its id, or
 * a function of the workbench's own that gives all there are to be.
 */
export type WorkbenchContributions =
  | readonly WorkbenchContribution[]
  | ((own: readonly WorkbenchContribution[]) => readonly WorkbenchContribution[]);

export function resolveContributions(
  own: readonly WorkbenchContribution[],
  given: WorkbenchContributions | undefined,
): readonly WorkbenchContribution[] {
  if (given === undefined) {
    return own;
  }
  if (typeof given === "function") {
    return given(own);
  }
  const replaced = new Set(given.map((one) => one.id));
  return [...own.filter((one) => !replaced.has(one.id)), ...given];
}

/** A slot's contributions in their order, by group. */
export function groupContributions(
  contributions: readonly WorkbenchContribution[],
  slot: WorkbenchSlotName,
): ReadonlyArray<readonly [group: string, contributions: readonly WorkbenchContribution[]]> {
  const ordered = contributions
    .filter((one) => one.slot === slot)
    .toSorted((left, right) => (left.order ?? 0) - (right.order ?? 0));
  const groups = new Map<string, WorkbenchContribution[]>();
  for (const one of ordered) {
    const group = one.group ?? "";
    groups.set(group, [...(groups.get(group) ?? []), one]);
  }
  return [...groups];
}
