// In-page helpers for the worker's document restore (src/restore-document.ts). The worker
// evaluates this bundle into a handle and calls these functions on it; values go through
// Playwright actions where it can, and these setters only cover what Playwright cannot do.
import type { Target } from "../schema.js";
import { resolveLocator } from "./locator.js";

type DocumentState = NonNullable<Target["documentState"]>;
type ControlState = DocumentState["controls"][number];
type EditableState = DocumentState["contentEditables"][number];
type ScrollState = DocumentState["scrollPositions"][number];
type SelectionState = NonNullable<DocumentState["selection"]>;
type SelectionEndpoint = SelectionState["anchor"];

export type ControlKind = "fill" | "check" | "select" | "native" | "none";

export { resolveLocator as resolve };

const unfillableInputTypes = new Set(["hidden", "range", "color", "button", "submit", "reset"]);

/** Chooses the Playwright action that restores a control. */
export function controlKind(element: Element): ControlKind {
  if (element instanceof HTMLSelectElement) return "select";
  if (element instanceof HTMLTextAreaElement) return "fill";
  if (!(element instanceof HTMLInputElement) || element.type === "file") return "none";
  if (element.type === "checkbox" || element.type === "radio") return "check";
  return unfillableInputTypes.has(element.type) ? "native" : "fill";
}

/** Returns the first label of a control, which styled checkboxes use as their visible part. */
export function label(element: Element): HTMLLabelElement | null {
  return "labels" in element ? ((element.labels as NodeListOf<HTMLLabelElement>)[0] ?? null) : null;
}

/** Reports whether the control already holds the saved state. */
export function matches(element: Element, control: ControlState): boolean {
  if (element instanceof HTMLSelectElement && control.selectedIndices !== undefined) {
    const selected = Array.from(element.selectedOptions, (option) => option.index);
    return selected.join() === control.selectedIndices.join();
  }
  if (element instanceof HTMLInputElement && control.checked !== undefined) {
    return element.checked === control.checked;
  }
  return "value" in element && element.value === control.value;
}

/**
 * Sets a control the way user input would, through the native setters that framework
 * wrappers observe, for controls Playwright cannot act on.
 */
export function setControl(element: Element, control: ControlState): void {
  if (element instanceof HTMLSelectElement) {
    if (control.selectedIndices === undefined) {
      nativeSet(element, HTMLSelectElement, "value", control.value);
    } else {
      const selected = new Set(control.selectedIndices);
      for (const option of element.options) option.selected = selected.has(option.index);
    }
  } else if (element instanceof HTMLInputElement) {
    if (control.checked === undefined) nativeSet(element, HTMLInputElement, "value", control.value);
    else nativeSet(element, HTMLInputElement, "checked", control.checked);
  } else if (element instanceof HTMLTextAreaElement) {
    nativeSet(element, HTMLTextAreaElement, "value", control.value);
  } else {
    return;
  }

  element.dispatchEvent(
    new InputEvent("input", { bubbles: true, inputType: "insertReplacementText" }),
  );
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

export function setSelectionRange(element: Element, selection: ControlState["selection"]): void {
  if (
    !selection ||
    !(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
  ) {
    return;
  }
  try {
    element.setSelectionRange(selection.start, selection.end, selection.direction);
  } catch {
    // Some input types do not support text selection.
  }
}

export function restoreEditable(editable: EditableState): void {
  const element = resolveLocator(editable.locator);
  if (!element?.isContentEditable || element.innerHTML === editable.html) return;
  element.innerHTML = editable.html;
  element.dispatchEvent(
    new InputEvent("input", { bubbles: true, inputType: "insertReplacementText" }),
  );
}

export function restoreScroll(
  positions: readonly ScrollState[],
  windowScroll?: { x: number; y: number },
): void {
  for (const position of positions)
    resolveLocator(position.locator)?.scrollTo(position.x, position.y);
  if (windowScroll) scrollTo(windowScroll.x, windowScroll.y);
}

export function restoreSelection(selection: SelectionState): void {
  const anchor = resolveEndpoint(selection.anchor);
  const focus = resolveEndpoint(selection.focus);
  if (!anchor || !focus) return;
  try {
    document.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
  } catch {
    // The saved offsets no longer fit the current nodes.
  }
}

function resolveEndpoint(endpoint: SelectionEndpoint): { node: Node; offset: number } | null {
  let node: Node | undefined = resolveLocator(endpoint.locator) ?? undefined;
  for (const index of endpoint.nodePath) node = node?.childNodes[index];
  return node ? { node, offset: endpoint.offset } : null;
}

function nativeSet<T extends HTMLElement>(
  element: T,
  constructor: { prototype: T },
  property: string,
  value: string | boolean,
): void {
  // oxlint-disable-next-line typescript/unbound-method
  const setter = Object.getOwnPropertyDescriptor(constructor.prototype, property)?.set;
  if (!setter) throw new Error(`browser omitted the native ${property} setter`);
  setter.call(element, value);
}
