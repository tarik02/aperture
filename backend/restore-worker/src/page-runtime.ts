import codecSource from "./structured-clone-codec.txt";

export function targetStateSource(state: unknown): string {
  return codecSource + "\n" + String.raw`(() => {
  const state = ${JSON.stringify(state)};
  if (globalThis.top !== globalThis) return;

  globalThis[Symbol.for("aperture.initial-window-open")] = globalThis.open.bind(globalThis);
  const marker = Symbol.for("aperture.initial-document-state");
  const documentState = state.documentState;
  if (documentState) globalThis[marker] = { status: "pending" };

  const fail = (error) => {
    globalThis[marker] = {
      status: "failed",
      error: error instanceof Error ? error.name + ": " + error.message : String(error),
    };
  };
  try {
    const capturedURL = new URL(state.url).href;
    const restoreTarget = location.href === capturedURL;
    const restoreDocument = Boolean(documentState && restoreTarget);
    if (restoreDocument && documentState.windowName !== undefined) {
      window.name = documentState.windowName;
    }

    let historyRestored = false;
    const restoreHistory = () => {
      if (!historyRestored && restoreDocument && documentState.historyState !== undefined) {
        history.replaceState(ApertureStructuredCloneCodec.decodeStructuredClone(documentState.historyState), "");
        historyRestored = true;
      }
    };

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
      if (interrupted || !restoreTarget) return;
      for (const control of documentState?.controls || []) restoreControl(control, dispatchEvents);
      for (const editable of documentState?.contentEditables || []) restoreEditable(editable, dispatchEvents);
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
        if (documentState) globalThis[marker] = { status: "succeeded" };
      } catch (error) {
        fail(error);
      }
      const retry = () => { try { finalReplay(); } catch {} };
      requestAnimationFrame(() => requestAnimationFrame(retry));
      setTimeout(retry, 100);
      setTimeout(retry, 500);
    };
    const ready = () => {
      if (safeStart()) complete();
    };
    if (document.readyState === "loading") addEventListener("DOMContentLoaded", ready, { once: true });
    else ready();
  } catch (error) {
    if (documentState) fail(error);
  }
})()`;
}

export function sessionStorageSource(state: unknown): string {
  return String.raw`(() => {
  const state = ${JSON.stringify(state)};
  if (location.origin !== state.origin) return;
  sessionStorage.clear();
  for (const entry of state.entries) sessionStorage.setItem(entry.name, entry.value);
})()`;
}

export function originStorageSource(state: unknown): string {
  return codecSource + "\n" + String.raw`(async () => {
  try {
    const state = ${JSON.stringify(state)};
    const fromBase64 = (body) => {
      const binary = atob(body);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      return bytes;
    };
    const keyPath = (specification) => {
      if (specification.kind === "none") return null;
      if (specification.kind === "string") return specification.value[0];
      return specification.value;
    };
    const transactionDone = (transaction) => new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
    });
    const openDatabase = (database) => new Promise((resolve, reject) => {
      const request = indexedDB.open(database.name, database.version);
      request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
      request.onblocked = () => reject(new Error("IndexedDB open was blocked"));
      request.onupgradeneeded = () => {
        const opened = request.result;
        for (const storeState of database.objectStores) {
          const store = opened.createObjectStore(storeState.name, {
            keyPath: keyPath(storeState.keyPath),
            autoIncrement: storeState.autoIncrement,
          });
          for (const index of storeState.indexes) {
            store.createIndex(index.name, keyPath(index.keyPath), {
              unique: index.unique,
              multiEntry: index.multiEntry,
            });
          }
        }
      };
      request.onsuccess = () => resolve(request.result);
    });

    localStorage.clear();
    for (const entry of state.localStorage) localStorage.setItem(entry.name, entry.value);
    for (const databaseState of state.indexedDB || []) {
      const database = await openDatabase(databaseState);
      try {
        for (const storeState of databaseState.objectStores) {
          const decoded = await Promise.all(storeState.records.map(async (record) => ({
            key: await ApertureStructuredCloneCodec.decodeStructuredCloneAsync(record.key),
            value: await ApertureStructuredCloneCodec.decodeStructuredCloneAsync(record.value),
          })));
          if (decoded.length === 0) continue;
          const transaction = database.transaction(storeState.name, "readwrite");
          const store = transaction.objectStore(storeState.name);
          for (const record of decoded) {
            if (store.keyPath === null) store.put(record.value, record.key);
            else store.put(record.value);
          }
          await transactionDone(transaction);
        }
      } finally {
        database.close();
      }
    }
    if (state.cacheStorage !== undefined && typeof caches === "undefined") {
      if (state.cacheStorage.length > 0) throw new Error("Cache Storage is unavailable");
    } else if (state.cacheStorage !== undefined) {
      for (const cacheName of await caches.keys()) await caches.delete(cacheName);
      for (const cacheState of state.cacheStorage || []) {
        const cache = await caches.open(cacheState.name);
        for (const entry of cacheState.entries) {
          const responseBody = [204, 205, 304].includes(entry.responseStatus)
            ? null
            : fromBase64(entry.responseBody);
          await cache.put(
            new Request(entry.url, { headers: entry.requestHeaders }),
            new Response(responseBody, {
              status: entry.responseStatus,
              statusText: entry.responseStatusText,
              headers: entry.responseHeaders,
            }),
          );
        }
      }
    }
    if (state.opfs !== undefined && typeof navigator.storage.getDirectory === "function") {
      const root = await navigator.storage.getDirectory();
      for await (const [name] of root.entries()) await root.removeEntry(name, { recursive: true });
      for (const fileState of state.opfs || []) {
        const parts = fileState.path.split("/");
        const fileName = parts.pop();
        let directory = root;
        for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: true });
        const file = await directory.getFileHandle(fileName, { create: true });
        const writer = await file.createWritable();
        await writer.write(fromBase64(fileState.body));
        await writer.close();
      }
    } else if ((state.opfs || []).length > 0) {
      throw new Error("OPFS is unavailable");
    }
    return { status: "succeeded" };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.name + ": " + error.message : String(error),
    };
  }
})()`;
}
