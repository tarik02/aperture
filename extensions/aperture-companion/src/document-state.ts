import type {
  InitialBrowserDocumentState,
  InitialBrowserElementLocator,
  InitialBrowserSelectionEndpoint,
} from "@aperture/api-client";

export interface CapturedDocumentState {
  href: string;
  hasOpener: boolean;
  state: InitialBrowserDocumentState;
  warnings: string[];
}

export async function captureDocumentState(tabId: number): Promise<CapturedDocumentState> {
  const target = { tabId, frameIds: [0] };
  await chrome.scripting.executeScript({ target, files: ["capture-codec.js"] });
  const [injection] = await chrome.scripting.executeScript({
    target,
    func: captureTopDocumentState,
  });
  if (injection?.result === undefined) {
    throw new Error("The page did not return document state");
  }
  return injection.result;
}

async function captureTopDocumentState(): Promise<CapturedDocumentState> {
  const warnings: string[] = [];
  const codec = (
    globalThis as typeof globalThis & {
      [key: symbol]: {
        encodeStructuredClone(value: unknown, allowCryptoKeys: boolean): Promise<string>;
      };
    }
  )[Symbol.for("aperture.structured-clone-codec")];
  if (codec === undefined) {
    throw new Error("The browser state codec is unavailable");
  }

  function elementLocator(element: HTMLElement): InitialBrowserElementLocator {
    const tag = element.localName;
    const path: InitialBrowserElementLocator["path"] = [];
    let current: Element | null = element;
    while (current !== null && current !== document.documentElement) {
      const parent: Element | null = current.parentElement;
      if (parent === null) break;
      const siblings = Array.from(parent.children).filter(
        (candidate) => candidate.localName === current?.localName,
      );
      path.unshift({ tag: current.localName, index: siblings.indexOf(current) });
      current = parent;
    }
    const attribute = (name: string): string | undefined => {
      const value = element.getAttribute(name);
      return value === null || value === "" ? undefined : value;
    };
    return {
      tag,
      ...(element.id === "" ? {} : { id: element.id }),
      ...(attribute("name") === undefined ? {} : { name: attribute("name") }),
      ...(element instanceof HTMLInputElement ? { inputType: element.type } : {}),
      ...(attribute("autocomplete") === undefined
        ? {}
        : { autocomplete: attribute("autocomplete") }),
      ...(attribute("aria-label") === undefined ? {} : { ariaLabel: attribute("aria-label") }),
      ...(attribute("placeholder") === undefined ? {} : { placeholder: attribute("placeholder") }),
      path,
    };
  }

  function selectionEndpoint(
    node: Node | null,
    offset: number,
  ): InitialBrowserSelectionEndpoint | null {
    if (node === null) return null;
    const element = node instanceof HTMLElement ? node : node.parentElement;
    if (element === null) return null;
    const nodePath: number[] = [];
    let current: Node | null = node;
    while (current !== element) {
      const parent: Node | null = current?.parentNode ?? null;
      if (current === null || parent === null) return null;
      nodePath.unshift(Array.prototype.indexOf.call(parent.childNodes, current));
      current = parent;
    }
    return { locator: elementLocator(element), nodePath, offset };
  }

  const controls: InitialBrowserDocumentState["controls"] = [];
  for (const element of document.querySelectorAll("input, textarea, select")) {
    if (element instanceof HTMLInputElement) {
      if (["button", "file", "image", "reset", "submit"].includes(element.type)) {
        if (element.type === "file" && element.files !== null && element.files.length > 0) {
          warnings.push("Selected files cannot be teleported");
        }
        continue;
      }
      const selection =
        element.selectionStart === null || element.selectionEnd === null
          ? undefined
          : {
              start: element.selectionStart,
              end: element.selectionEnd,
              direction: element.selectionDirection ?? "none",
            };
      controls.push({
        locator: elementLocator(element),
        value: element.value,
        ...(["checkbox", "radio"].includes(element.type) ? { checked: element.checked } : {}),
        ...(selection === undefined ? {} : { selection }),
      });
    } else if (element instanceof HTMLTextAreaElement) {
      controls.push({
        locator: elementLocator(element),
        value: element.value,
        selection: {
          start: element.selectionStart,
          end: element.selectionEnd,
          direction: element.selectionDirection,
        },
      });
    } else if (element instanceof HTMLSelectElement) {
      controls.push({
        locator: elementLocator(element),
        value: element.value,
        selectedIndices: Array.from(element.options)
          .map((option, index) => (option.selected ? index : -1))
          .filter((index) => index >= 0),
      });
    }
  }

  const contentEditables: InitialBrowserDocumentState["contentEditables"] = [];
  for (const element of document.querySelectorAll<HTMLElement>("[contenteditable]")) {
    if (!element.isContentEditable || element.parentElement?.isContentEditable === true) continue;
    contentEditables.push({ locator: elementLocator(element), html: element.innerHTML });
  }

  const scrollPositions: InitialBrowserDocumentState["scrollPositions"] = [];
  for (const element of document.querySelectorAll<HTMLElement>("*")) {
    if (
      element === document.documentElement ||
      element === document.body ||
      (element.scrollLeft === 0 && element.scrollTop === 0)
    ) {
      continue;
    }
    scrollPositions.push({
      locator: elementLocator(element),
      x: element.scrollLeft,
      y: element.scrollTop,
    });
  }

  const activeElement = document.activeElement;
  const focus =
    activeElement instanceof HTMLElement && activeElement !== document.body
      ? elementLocator(activeElement)
      : undefined;
  let selection: InitialBrowserDocumentState["selection"];
  const currentSelection = document.getSelection();
  const anchor = selectionEndpoint(
    currentSelection?.anchorNode ?? null,
    currentSelection?.anchorOffset ?? 0,
  );
  const selectionFocus = selectionEndpoint(
    currentSelection?.focusNode ?? null,
    currentSelection?.focusOffset ?? 0,
  );
  if (anchor !== null && selectionFocus !== null) {
    selection = { anchor, focus: selectionFocus };
  }

  let historyState: string | undefined;
  if (history.state !== null) {
    try {
      historyState = await codec.encodeStructuredClone(history.state, false);
    } catch (error) {
      warnings.push(
        `History state was skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const state: InitialBrowserDocumentState = {
    version: 1,
    ...(window.name === "" ? {} : { windowName: window.name }),
    ...(historyState === undefined ? {} : { historyState }),
    controls,
    contentEditables,
    scrollPositions,
    ...(focus === undefined ? {} : { focus }),
    ...(selection === undefined ? {} : { selection }),
  };
  if (new TextEncoder().encode(JSON.stringify(state)).byteLength > 32 * 1024 * 1024) {
    throw new Error("The page contains more than 32 MiB of document state");
  }
  return { href: location.href, hasOpener: window.opener !== null, state, warnings };
}
