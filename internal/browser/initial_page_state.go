package browser

import "fmt"

const (
	initialDocumentStateSymbol = "aperture.initial-document-state"
	initialWindowOpenSymbol    = "aperture.initial-window-open"
)

func targetStateRestoreSource(state []byte) string {
	return fmt.Sprintf(`(() => {
  const state = %s;
  if (globalThis.top !== globalThis) return;

  globalThis[Symbol.for(%q)] = globalThis.open.bind(globalThis);
  const marker = Symbol.for(%q);
  const documentState = state.documentState;
  if (documentState) globalThis[marker] = { status: "pending" };

  const fail = (error) => {
    globalThis[marker] = {
      status: "failed",
      error: error instanceof Error ? error.name + ": " + error.message : String(error),
    };
  };
  try {
    if (documentState && documentState.windowName !== undefined) window.name = documentState.windowName;
    const capturedURL = new URL(state.url).href;
    const restoreDocument = documentState && location.href === capturedURL;

    const fromBase64 = (body) => {
      const binary = atob(body);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      return bytes;
    };
    const decode = (encoded) => {
      const serialized = JSON.parse(encoded);
      const values = new Array(serialized.nodes.length);
      const constructors = {
        Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
        Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array,
        BigUint64Array, DataView,
      };
      for (let index = 0; index < serialized.nodes.length; index++) {
        const node = serialized.nodes[index];
        switch (node.type) {
          case "array": values[index] = []; break;
          case "object": values[index] = {}; break;
          case "map": values[index] = new Map(); break;
          case "set": values[index] = new Set(); break;
          case "date": values[index] = new Date(node.value); break;
          case "regexp": values[index] = new RegExp(node.source, node.flags); break;
          case "error": {
            const error = new Error(node.message);
            error.name = node.name;
            if (node.stack !== undefined) error.stack = node.stack;
            values[index] = error;
            break;
          }
          case "array-buffer": values[index] = fromBase64(node.body).buffer; break;
          case "typed-array": {
            const constructor = constructors[node.constructor];
            if (!constructor) throw new Error("unsupported typed array " + node.constructor);
            const bytes = fromBase64(node.body);
            values[index] = node.constructor === "DataView"
              ? new DataView(bytes.buffer)
              : new constructor(bytes.buffer);
            break;
          }
          case "blob": values[index] = new Blob([fromBase64(node.body)], { type: node.mimeType }); break;
          case "file": values[index] = new File([fromBase64(node.body)], node.name, {
            type: node.mimeType,
            lastModified: node.lastModified,
          }); break;
          default: throw new Error("unsupported structured-clone node " + node.type);
        }
      }
      const token = (value) => {
        if (value === null || typeof value !== "object") return value;
        if (Object.hasOwn(value, "ref")) return values[value.ref];
        switch (value.type) {
          case "undefined": return undefined;
          case "bigint": return BigInt(value.value);
          case "number": {
            if (value.value === "nan") return NaN;
            if (value.value === "positive-infinity") return Infinity;
            if (value.value === "negative-infinity") return -Infinity;
            if (value.value === "negative-zero") return -0;
            break;
          }
        }
        throw new Error("unsupported structured-clone token");
      };
      for (let index = 0; index < serialized.nodes.length; index++) {
        const node = serialized.nodes[index];
        const value = values[index];
        if (node.type === "array") {
          for (const item of node.values) value.push(token(item));
        } else if (node.type === "object") {
          for (const [name, item] of node.properties) Object.defineProperty(value, name, {
            value: token(item), enumerable: true, configurable: true, writable: true,
          });
        } else if (node.type === "map") {
          for (const [key, item] of node.entries) value.set(token(key), token(item));
        } else if (node.type === "set") {
          for (const item of node.values) value.add(token(item));
        } else if (node.type === "error") {
          value.cause = token(node.cause);
        }
      }
      return token(serialized.root);
    };

    if (restoreDocument && documentState.historyState !== undefined) {
      history.replaceState(decode(documentState.historyState), "");
    }

    const resolve = (locator) => {
      const compatible = (element) => {
        if (!(element instanceof HTMLElement) || element.localName !== locator.tag) return false;
        if (locator.inputType !== undefined && (!(element instanceof HTMLInputElement) || element.type !== locator.inputType)) return false;
        return true;
      };
      const sameIdentity = (element) => {
        if (locator.name !== undefined && element.getAttribute("name") !== locator.name) return false;
        if (locator.autocomplete !== undefined && element.getAttribute("autocomplete") !== locator.autocomplete) return false;
        if (locator.ariaLabel !== undefined && element.getAttribute("aria-label") !== locator.ariaLabel) return false;
        if (locator.placeholder !== undefined && element.getAttribute("placeholder") !== locator.placeholder) return false;
        return true;
      };
      const candidates = Array.from(document.getElementsByTagName(locator.tag)).filter(compatible);
      if (locator.id !== undefined) {
        const byID = candidates.filter((element) => element.id === locator.id);
        if (byID.length === 1) return byID[0];
      }
      const hasIdentity = locator.name !== undefined || locator.inputType !== undefined ||
        locator.autocomplete !== undefined || locator.ariaLabel !== undefined || locator.placeholder !== undefined;
      if (hasIdentity) {
        const semantic = candidates.filter(sameIdentity);
        if (semantic.length === 1) return semantic[0];
      }
      let current = document.documentElement;
      for (const step of locator.path) {
        const children = Array.from(current.children).filter((child) => child.localName === step.tag);
        current = children[step.index];
        if (!current) return null;
      }
      return compatible(current) ? current : null;
    };

    const nativeSet = (element, constructor, property, value) => {
      const setter = Object.getOwnPropertyDescriptor(constructor.prototype, property)?.set;
      if (!setter) throw new Error("browser omitted the native " + property + " setter");
      setter.call(element, value);
    };
    const eventedControls = new WeakSet();
    const eventedEditables = new WeakSet();
    const restoreControl = (control, dispatchEvents) => {
      const element = resolve(control.locator);
      try {
        if (element instanceof HTMLInputElement) {
          nativeSet(element, HTMLInputElement, "value", control.value);
          if (control.checked !== undefined) nativeSet(element, HTMLInputElement, "checked", control.checked);
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
          element.setSelectionRange(control.selection.start, control.selection.end, control.selection.direction);
        }
        if (dispatchEvents && !eventedControls.has(element)) {
          eventedControls.add(element);
          element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText" }));
          if (element instanceof HTMLSelectElement || control.checked !== undefined) {
            element.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
        return true;
      } catch {
        return false;
      }
    };
    const restoreEditable = (editable, dispatchEvents) => {
      const element = resolve(editable.locator);
      try {
        if (!element || !element.isContentEditable) return false;
        if (element.innerHTML !== editable.html) element.innerHTML = editable.html;
        if (dispatchEvents && !eventedEditables.has(element)) {
          eventedEditables.add(element);
          element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText" }));
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
    const resolveSelectionEndpoint = (endpoint) => {
      let node = resolve(endpoint.locator);
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
          try { element.focus({ preventScroll: true }); } catch {}
        }
      }
      if (documentState?.selection) {
        const anchor = resolveSelectionEndpoint(documentState.selection.anchor);
        const focus = resolveSelectionEndpoint(documentState.selection.focus);
        if (anchor && focus) {
          const selection = document.getSelection();
          if (selection) {
            try { selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset); } catch {}
          }
        }
      }
    };

    let interrupted = false;
    let hydrated = false;
    let observer;
    const interruptEvents = ["beforeinput", "keydown", "pointerdown"];
    const stop = () => {
      interrupted = true;
      observer?.disconnect();
      for (const eventName of interruptEvents) removeEventListener(eventName, interrupt, true);
    };
    const interrupt = (event) => { if (event.isTrusted) stop(); };
    for (const eventName of interruptEvents) {
      addEventListener(eventName, interrupt, { capture: true });
    }
    const replay = (dispatchEvents) => {
      if (interrupted || !restoreDocument) return;
      for (const control of documentState.controls) restoreControl(control, dispatchEvents);
      for (const editable of documentState.contentEditables) restoreEditable(editable, dispatchEvents);
      restoreScroll();
    };
    const start = () => {
      if (restoreDocument) {
        replay(false);
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
      try { start(); } catch (error) { fail(error); }
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
        if (documentState) globalThis[marker] = { status: "succeeded" };
      } catch (error) {
        fail(error);
      }
      const retry = () => { try { finalReplay(); } catch {} };
      requestAnimationFrame(() => requestAnimationFrame(retry));
      setTimeout(retry, 100);
      setTimeout(retry, 500);
    };
    if (document.readyState === "loading") {
      addEventListener("DOMContentLoaded", safeStart, { once: true });
      addEventListener("load", complete, { once: true });
    } else {
      safeStart();
      if (document.readyState === "complete") complete();
      else addEventListener("load", complete, { once: true });
    }
  } catch (error) {
    if (documentState) fail(error);
  }
})()`, state, initialWindowOpenSymbol, initialDocumentStateSymbol)
}

func targetSessionStorageRestoreSource(state []byte) string {
	return fmt.Sprintf(`(() => {
  const state = %s;
  if (location.origin !== state.origin) return;
  sessionStorage.clear();
  for (const entry of state.entries) sessionStorage.setItem(entry.name, entry.value);
})()`, state)
}
