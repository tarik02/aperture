import type { Target } from "../schema.js";
import { resolveLocator } from "./locator.js";

type DocumentState = NonNullable<Target["documentState"]>;
type ControlState = DocumentState["controls"][number];
type EditableState = DocumentState["contentEditables"][number];
type SelectionEndpoint = NonNullable<DocumentState["selection"]>["anchor"];

export interface DocumentReplay {
  replay(dispatchEvents: boolean): void;
  restoreFocusAndSelection(): void;
  restoreScroll(): void;
}

function nativeSet(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  constructor: typeof HTMLInputElement | typeof HTMLTextAreaElement | typeof HTMLSelectElement,
  property: string,
  value: string | boolean | null,
): void {
  const setter = Object.getOwnPropertyDescriptor(constructor.prototype, property)?.set;
  if (!setter) throw new Error("browser omitted the native " + property + " setter");
  setter.call(element, value);
}

function resolveSelectionEndpoint(
  endpoint: SelectionEndpoint,
): { node: Node; offset: number } | null {
  let node: Node | null = resolveLocator(endpoint.locator);
  if (!node) return null;

  for (const index of endpoint.nodePath) {
    node = node.childNodes[index];
    if (!node) return null;
  }

  return { node, offset: endpoint.offset };
}

export function createDocumentReplay(state: Target): DocumentReplay {
  const documentState = state.documentState;
  const eventedControls = new WeakSet<Element>();
  const eventedEditables = new WeakSet<Element>();

  const restoreControl = (control: ControlState, dispatchEvents: boolean): void => {
    const element = resolveLocator(control.locator);

    try {
      if (element instanceof HTMLInputElement) {
        nativeSet(element, HTMLInputElement, "value", control.value);
        if (control.checked !== undefined) {
          nativeSet(element, HTMLInputElement, "checked", control.checked);
        }
      } else if (element instanceof HTMLTextAreaElement) {
        nativeSet(element, HTMLTextAreaElement, "value", control.value);
      } else if (element instanceof HTMLSelectElement) {
        if (control.selectedIndices !== undefined) {
          const selected = new Set(control.selectedIndices);
          for (let index = 0; index < element.options.length; index++) {
            element.options[index].selected = selected.has(index);
          }
        } else {
          nativeSet(element, HTMLSelectElement, "value", control.value);
        }
      } else {
        return;
      }

      if (control.selection !== undefined && "setSelectionRange" in element) {
        if (control.selection === null) return;
        element.setSelectionRange(
          control.selection.start,
          control.selection.end,
          control.selection.direction,
        );
      }

      if (dispatchEvents && !eventedControls.has(element)) {
        eventedControls.add(element);
        element.dispatchEvent(
          new InputEvent("input", { bubbles: true, inputType: "insertReplacementText" }),
        );
        if (element instanceof HTMLSelectElement || control.checked !== undefined) {
          element.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
    } catch {
      // A missing or incompatible control may appear later during hydration.
    }
  };

  const restoreEditable = (editable: EditableState, dispatchEvents: boolean): void => {
    const element = resolveLocator(editable.locator);

    try {
      if (!element || !element.isContentEditable) return;
      if (element.innerHTML !== editable.html) element.innerHTML = editable.html;
      if (dispatchEvents && !eventedEditables.has(element)) {
        eventedEditables.add(element);
        element.dispatchEvent(
          new InputEvent("input", { bubbles: true, inputType: "insertReplacementText" }),
        );
      }
    } catch {
      // A missing or incompatible editable may appear later during hydration.
    }
  };

  const restoreScroll = (): void => {
    for (const position of documentState?.scrollPositions ?? []) {
      const element = resolveLocator(position.locator);
      if (element) element.scrollTo(position.x, position.y);
    }

    if (state.scroll) scrollTo(state.scroll.x, state.scroll.y);
  };

  const restoreFocusAndSelection = (): void => {
    if (documentState?.focus) {
      const element = resolveLocator(documentState.focus);
      if (element) {
        try {
          element.focus({ preventScroll: true });
        } catch {
          // The element may no longer be focusable after hydration.
        }
      }
    }

    if (documentState?.selection) {
      const anchor = resolveSelectionEndpoint(documentState.selection.anchor);
      const focus = resolveSelectionEndpoint(documentState.selection.focus);
      if (anchor && focus) {
        const selection = document.getSelection();
        if (selection) {
          try {
            selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
          } catch {
            // The selected nodes may have been replaced during hydration.
          }
        }
      }
    }
  };

  const replay = (dispatchEvents: boolean): void => {
    for (const control of documentState?.controls ?? []) {
      restoreControl(control, dispatchEvents);
    }

    for (const editable of documentState?.contentEditables ?? []) {
      restoreEditable(editable, dispatchEvents);
    }

    restoreScroll();
  };

  return { replay, restoreFocusAndSelection, restoreScroll };
}
