import { decodeStructuredClone } from "@aperture/browser-state";
import type { Target } from "../schema.js";

interface Locator {
  tag: string;
  id?: string;
  name?: string;
  inputType?: string;
  autocomplete?: string;
  ariaLabel?: string;
  placeholder?: string;
  path: { tag: string; index: number }[];
}

type DocumentState = NonNullable<Target["documentState"]>;
type ControlState = DocumentState["controls"][number];
type EditableState = DocumentState["contentEditables"][number];
type SelectionEndpoint = NonNullable<DocumentState["selection"]>["anchor"];

export function run(state: Target): void {
  if (window.top !== window) return;

  Reflect.set(window, Symbol.for("aperture.initial-window-open"), window.open.bind(window));
  const marker = Symbol.for("aperture.initial-document-state");
  const documentState = state.documentState;
  if (documentState) Reflect.set(window, marker, { status: "pending" });

  const fail = (error: unknown): void => {
    Reflect.set(window, marker, {
      status: "failed",
      error: error instanceof Error ? error.name + ": " + error.message : String(error),
    });
  };

  try {
    const capturedURL = new URL(state.url).href;
    const restoreTarget = location.href === capturedURL;
    const restoreDocument = Boolean(documentState && restoreTarget);
    if (restoreDocument && documentState?.windowName !== undefined) {
      window.name = String(documentState.windowName);
    }

    let historyRestored = false;
    const restoreHistory = () => {
      if (!historyRestored && restoreDocument && documentState?.historyState !== undefined) {
        history.replaceState(decodeStructuredClone(String(documentState.historyState)), "");
        historyRestored = true;
      }
    };

    const resolve = (locator: Locator): HTMLElement | null => {
      const compatible = (element: Element): element is HTMLElement => {
        if (!(element instanceof HTMLElement) || element.localName !== locator.tag) return false;
        if (
          locator.inputType !== undefined &&
          (!(element instanceof HTMLInputElement) || element.type !== locator.inputType)
        )
          return false;
        return true;
      };

      const sameIdentity = (element: Element): boolean => {
        if (locator.name !== undefined && element.getAttribute("name") !== locator.name)
          return false;
        if (
          locator.autocomplete !== undefined &&
          element.getAttribute("autocomplete") !== locator.autocomplete
        )
          return false;
        if (
          locator.ariaLabel !== undefined &&
          element.getAttribute("aria-label") !== locator.ariaLabel
        )
          return false;
        if (
          locator.placeholder !== undefined &&
          element.getAttribute("placeholder") !== locator.placeholder
        )
          return false;
        return true;
      };

      const candidates = Array.from(document.getElementsByTagName(locator.tag)).filter(compatible);
      if (locator.id !== undefined) {
        const byID = candidates.filter((element) => element.id === locator.id);
        if (byID.length === 1) return byID[0];
      }

      const hasIdentity =
        locator.name !== undefined ||
        locator.inputType !== undefined ||
        locator.autocomplete !== undefined ||
        locator.ariaLabel !== undefined ||
        locator.placeholder !== undefined;
      if (hasIdentity) {
        const semantic = candidates.filter(sameIdentity);
        if (semantic.length === 1) return semantic[0];
      }

      let current: Element = document.documentElement;
      for (const step of locator.path) {
        const children = Array.from(current.children).filter(
          (child) => child.localName === step.tag,
        );
        current = children[step.index];
        if (!current) return null;
      }

      return compatible(current) ? current : null;
    };

    const nativeSet = (
      element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
      constructor: typeof HTMLInputElement | typeof HTMLTextAreaElement | typeof HTMLSelectElement,
      property: string,
      value: string | boolean | null,
    ): void => {
      const setter = Object.getOwnPropertyDescriptor(constructor.prototype, property)?.set;
      if (!setter) throw new Error("browser omitted the native " + property + " setter");
      setter.call(element, value);
    };

    const eventedControls = new WeakSet();
    const eventedEditables = new WeakSet();

    const restoreControl = (control: ControlState, dispatchEvents: boolean): boolean => {
      const element = resolve(control.locator);

      try {
        if (element instanceof HTMLInputElement) {
          nativeSet(element, HTMLInputElement, "value", control.value);
          if (control.checked !== undefined)
            nativeSet(element, HTMLInputElement, "checked", control.checked);
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
          return false;
        }

        if (control.selection !== undefined && "setSelectionRange" in element) {
          if (control.selection === null) return false;
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

        return true;
      } catch {
        return false;
      }
    };

    const restoreEditable = (editable: EditableState, dispatchEvents: boolean): boolean => {
      const element = resolve(editable.locator);

      try {
        if (!element || !element.isContentEditable) return false;
        if (element.innerHTML !== editable.html) element.innerHTML = editable.html;
        if (dispatchEvents && !eventedEditables.has(element)) {
          eventedEditables.add(element);
          element.dispatchEvent(
            new InputEvent("input", { bubbles: true, inputType: "insertReplacementText" }),
          );
        }

        return true;
      } catch {
        return false;
      }
    };

    const restoreScroll = () => {
      for (const position of documentState?.scrollPositions || []) {
        const element = resolve(position.locator);
        if (element) element.scrollTo(position.x, position.y);
      }

      if (state.scroll) scrollTo(state.scroll.x, state.scroll.y);
    };

    const resolveSelectionEndpoint = (endpoint: SelectionEndpoint) => {
      let node: Node | null = resolve(endpoint.locator);
      if (!node) return null;

      for (const index of endpoint.nodePath) {
        node = node.childNodes[index];
        if (!node) return null;
      }

      return { node, offset: endpoint.offset };
    };

    const restoreFocusAndSelection = () => {
      if (documentState?.focus) {
        const element = resolve(documentState.focus);
        if (element) {
          try {
            element.focus({ preventScroll: true });
          } catch {}
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
            } catch {}
          }
        }
      }
    };

    let interrupted = false;
    let hydrated = false;
    let observer: MutationObserver | undefined;
    const interruptEvents = ["beforeinput", "keydown", "pointerdown"];

    const stop = () => {
      interrupted = true;
      observer?.disconnect();
      for (const eventName of interruptEvents) removeEventListener(eventName, interrupt, true);
    };

    const interrupt = (event: Event): void => {
      if (event.isTrusted) stop();
    };

    for (const eventName of interruptEvents) {
      addEventListener(eventName, interrupt, { capture: true });
    }

    const replay = (dispatchEvents: boolean): void => {
      if (interrupted || !restoreTarget) return;
      for (const control of documentState?.controls || []) {
        restoreControl(control, dispatchEvents);
      }
      for (const editable of documentState?.contentEditables || []) {
        restoreEditable(editable, dispatchEvents);
      }
      restoreScroll();
    };

    const start = () => {
      if (restoreTarget) {
        restoreHistory();
        replay(false);
      }
      if (restoreDocument) {
        let scheduled = false;
        observer = new MutationObserver(() => {
          if (scheduled || interrupted) return;
          scheduled = true;
          requestAnimationFrame(() => {
            scheduled = false;
            replay(hydrated);
          });
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        setTimeout(() => observer?.disconnect(), 5000);
      }
    };

    const safeStart = () => {
      try {
        start();
        return true;
      } catch (error) {
        fail(error);
        return false;
      }
    };

    const finalReplay = () => {
      hydrated = true;
      replay(true);
      if (!interrupted && restoreDocument) {
        restoreFocusAndSelection();
        restoreScroll();
      }
    };

    const complete = () => {
      try {
        finalReplay();
        if (documentState) Reflect.set(window, marker, { status: "succeeded" });
      } catch (error) {
        fail(error);
      }

      const retry = () => {
        try {
          finalReplay();
        } catch {}
      };

      requestAnimationFrame(() => requestAnimationFrame(retry));
      setTimeout(retry, 100);
      setTimeout(retry, 500);
    };

    const ready = () => {
      if (safeStart()) complete();
    };

    if (document.readyState === "loading")
      addEventListener("DOMContentLoaded", ready, { once: true });
    else ready();
  } catch (error) {
    if (documentState) fail(error);
  }
}
