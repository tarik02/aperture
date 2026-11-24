// Reads and writes what a tab's document has that the browser keeps nowhere, given what
// `stored.js` evaluates to: where it is scrolled to, `window.name`, `history.state`, what
// its form controls and editable parts hold, where each part of it is scrolled to, what
// has the focus and what is selected.
//
//   { scroll: { x, y }, windowName, historyState: <encoded as stored.js has it>,
//     controls: [{ locator, value, checked, selectedIndices, selection }],
//     editables: [{ locator, html }], scrolls: [{ locator, x, y }],
//     focus: locator, selection: { anchor: { locator, nodePath, offset }, focus: … } }
//
// An element is found again by a locator: its tag, what names it, and the way to it from
// the document's root.
//
//   { tag, id, name, inputType, autocomplete, ariaLabel, placeholder, path: [{ tag, index }] }
(stored) => {
  /** The original `window.open`, kept where a page's own scripts do not look for it. */
  const OPEN = Symbol.for("aperture.state.open");
  /** How long a document may keep changing before it is taken to be at rest. */
  const QUIET = 300;
  const SETTLES_WITHIN = 3000;
  /** How long a page gets to answer what was written into it. */
  const REACTS_WITHIN = 500;

  const locate = (element) => {
    const path = [];
    for (let at = element; at !== document.documentElement; at = at.parentElement) {
      const parent = at.parentElement;
      if (parent === null) break;
      const alike = [...parent.children].filter((child) => child.localName === at.localName);
      path.unshift({ tag: at.localName, index: alike.indexOf(at) });
    }
    const said = (name) => element.getAttribute(name) || undefined;
    return {
      tag: element.localName,
      id: element.id || undefined,
      name: said("name"),
      inputType: element instanceof HTMLInputElement ? element.type : undefined,
      autocomplete: said("autocomplete"),
      ariaLabel: said("aria-label"),
      placeholder: said("placeholder"),
      path,
    };
  };

  // By its id where one element has it, then by what names it, then by the way to it.
  const find = (locator) => {
    const fits = (element) =>
      element instanceof HTMLElement &&
      element.localName === locator.tag &&
      (locator.inputType === undefined ||
        (element instanceof HTMLInputElement && element.type === locator.inputType));
    const names = [
      ["name", locator.name],
      ["autocomplete", locator.autocomplete],
      ["aria-label", locator.ariaLabel],
      ["placeholder", locator.placeholder],
    ].filter(([, value]) => value !== undefined);
    const candidates = [...document.getElementsByTagName(locator.tag)].filter(fits);
    if (locator.id !== undefined) {
      const byId = candidates.filter((element) => element.id === locator.id);
      if (byId.length === 1) return byId[0];
    }
    if (names.length > 0 || locator.inputType !== undefined) {
      const named = candidates.filter((element) =>
        names.every(([name, value]) => element.getAttribute(name) === value),
      );
      if (named.length === 1) return named[0];
    }
    let at = document.documentElement;
    for (const step of locator.path ?? []) {
      at = [...at.children].filter((child) => child.localName === step.tag)[step.index];
      if (at === undefined) return null;
    }
    return fits(at) ? at : null;
  };

  const endpoint = (node, offset) => {
    if (node === null) return null;
    const element = node instanceof HTMLElement ? node : node.parentElement;
    if (element === null) return null;
    const nodePath = [];
    for (let at = node; at !== element; at = at.parentNode) {
      if (at.parentNode === null) return null;
      nodePath.unshift([...at.parentNode.childNodes].indexOf(at));
    }
    return { locator: locate(element), nodePath, offset };
  };

  const read = async () => {
    const leftOut = [];
    const controls = [];
    for (const element of document.querySelectorAll("input, textarea, select")) {
      if (element instanceof HTMLInputElement) {
        if (["button", "file", "image", "reset", "submit"].includes(element.type)) {
          if (element.type === "file" && element.files?.length > 0) {
            leftOut.push("the files chosen in a form");
          }
          continue;
        }
        controls.push({
          locator: locate(element),
          value: element.value,
          checked: ["checkbox", "radio"].includes(element.type) ? element.checked : undefined,
          selection:
            element.selectionStart === null || element.selectionEnd === null
              ? undefined
              : {
                  start: element.selectionStart,
                  end: element.selectionEnd,
                  direction: element.selectionDirection ?? "none",
                },
        });
      } else if (element instanceof HTMLTextAreaElement) {
        controls.push({
          locator: locate(element),
          value: element.value,
          selection: {
            start: element.selectionStart,
            end: element.selectionEnd,
            direction: element.selectionDirection,
          },
        });
      } else {
        controls.push({
          locator: locate(element),
          value: element.value,
          selectedIndices: [...element.selectedOptions].map((option) => option.index),
        });
      }
    }

    const editables = [];
    for (const element of document.querySelectorAll("[contenteditable]")) {
      if (element.isContentEditable && element.parentElement?.isContentEditable !== true) {
        editables.push({ locator: locate(element), html: element.innerHTML });
      }
    }

    const scrolls = [];
    for (const element of document.querySelectorAll("*")) {
      const whole = element === document.documentElement || element === document.body;
      if (!whole && element instanceof HTMLElement && (element.scrollLeft || element.scrollTop)) {
        scrolls.push({ locator: locate(element), x: element.scrollLeft, y: element.scrollTop });
      }
    }

    const active = document.activeElement;
    const chosen = document.getSelection();
    const anchor = endpoint(chosen?.anchorNode ?? null, chosen?.anchorOffset ?? 0);
    const focus = endpoint(chosen?.focusNode ?? null, chosen?.focusOffset ?? 0);

    let historyState;
    if (history.state !== null) {
      try {
        historyState = await stored.encode(history.state);
      } catch (error) {
        leftOut.push(`history.state: ${error.message}`);
      }
    }
    return {
      document: {
        scroll: { x: scrollX, y: scrollY },
        windowName: window.name || undefined,
        historyState,
        controls,
        editables,
        scrolls,
        focus:
          active instanceof HTMLElement && active !== document.body ? locate(active) : undefined,
        selection: anchor !== null && focus !== null ? { anchor, focus } : undefined,
      },
      leftOut,
    };
  };

  // Runs in every document of the tab before the page's own scripts do: what a page reads
  // as it starts is there by then. `opens` is for a tab whose pages are to open others.
  const early = ({ url, windowName, sessionStorage: kept, opens }) => {
    for (const { origin, entries } of kept ?? []) {
      if (location.origin !== origin) continue;
      try {
        sessionStorage.clear();
        for (const { name, value } of entries) sessionStorage.setItem(name, value);
      } catch {
        // A document that is let keep nothing.
      }
    }
    if (window.top !== window) return;
    if (opens) window[OPEN] = window.open.bind(window);
    // The name was the tab's at this address, not wherever it was sent on to.
    if (typeof windowName === "string" && location.href === new URL(url).href) {
      window.name = windowName;
    }
  };

  /** Opens an empty tab this one is the opener of. */
  const open = () => (window[OPEN] ?? window.open)("about:blank", "_blank") !== null;

  /** Takes back what `early` left for `open`, once every tab is opened. */
  const forget = () => delete window[OPEN];

  const holds = (element, control) => {
    if (element instanceof HTMLSelectElement && control.selectedIndices !== undefined) {
      const selected = [...element.selectedOptions].map((option) => option.index);
      return selected.join() === control.selectedIndices.join();
    }
    if (element instanceof HTMLInputElement && typeof control.checked === "boolean") {
      return element.checked === control.checked;
    }
    return element.value === control.value;
  };

  // Through the setters of the element's own kind, which is what a page that wraps its
  // controls looks at, and with the events typing would have made.
  const set = (element, control) => {
    const through = (kind, property, value) =>
      Object.getOwnPropertyDescriptor(kind.prototype, property).set.call(element, value);
    if (element instanceof HTMLSelectElement) {
      if (control.selectedIndices === undefined) {
        through(HTMLSelectElement, "value", control.value);
      } else {
        const selected = new Set(control.selectedIndices);
        for (const option of element.options) option.selected = selected.has(option.index);
      }
    } else if (element instanceof HTMLInputElement) {
      if (element.type === "file") return;
      if (typeof control.checked === "boolean") {
        through(HTMLInputElement, "checked", control.checked);
      } else {
        through(HTMLInputElement, "value", control.value);
      }
    } else if (element instanceof HTMLTextAreaElement) {
      through(HTMLTextAreaElement, "value", control.value);
    } else {
      return;
    }
    element.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertReplacementText" }),
    );
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const control = (given) => {
    const element = find(given.locator);
    if (element !== null && !holds(element, given)) set(element, given);
  };

  /** What of a control's text is selected. */
  const range = ({ locator, selection }) => {
    const element = selection ? find(locator) : null;
    if (typeof element?.setSelectionRange !== "function") return;
    try {
      element.setSelectionRange(selection.start, selection.end, selection.direction);
    } catch {
      // A kind of input that has no selection.
    }
  };

  /** Waits until the document stopped changing for a moment, or long enough. */
  const settled = () =>
    new Promise((done) => {
      let quiet = setTimeout(finish, QUIET);
      const watching = new MutationObserver(() => {
        clearTimeout(quiet);
        quiet = setTimeout(finish, QUIET);
      });
      const most = setTimeout(finish, SETTLES_WITHIN);
      function finish() {
        clearTimeout(quiet);
        clearTimeout(most);
        watching.disconnect();
        done();
      }
      watching.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    });

  const node = (given) => {
    let at = find(given.locator) ?? undefined;
    for (const index of given.nodePath ?? []) at = at?.childNodes[index];
    return at;
  };

  // For a document that has loaded. One that is at another address than the state was
  // taken at, as where it was sent on to, is left as it is.
  const write = async (given, url) => {
    if (location.href !== new URL(url).href) return false;
    if (given.historyState !== undefined) {
      history.replaceState(await stored.decode(given.historyState), "");
    }
    // A page that fills itself in as it starts would write over what is put there before.
    await settled();
    for (const one of given.controls ?? []) control(one);
    for (const { locator, html } of given.editables ?? []) {
      const element = find(locator);
      if (element?.isContentEditable && element.innerHTML !== html) {
        element.innerHTML = html;
        element.dispatchEvent(
          new InputEvent("input", { bubbles: true, inputType: "insertReplacementText" }),
        );
      }
    }
    // Again, for the controls the page set back or made while answering the first time.
    await new Promise((done) => setTimeout(done, REACTS_WITHIN));
    for (const one of given.controls ?? []) control(one);

    if (given.focus) find(given.focus)?.focus();
    if (given.selection) {
      const anchor = node(given.selection.anchor);
      const focus = node(given.selection.focus);
      if (anchor && focus) {
        try {
          const { anchor: from, focus: to } = given.selection;
          document.getSelection()?.setBaseAndExtent(anchor, from.offset, focus, to.offset);
        } catch {
          // The offsets fit the nodes no more.
        }
      }
    }
    // After the document's selection, which takes a control's own with it.
    for (const one of given.controls ?? []) range(one);
    // Last: giving a control its value and the focus scrolls it into view.
    for (const { locator, x, y } of given.scrolls ?? []) find(locator)?.scrollTo(x, y);
    if (given.scroll) scrollTo(given.scroll.x, given.scroll.y);
    return true;
  };

  return { read, early, open, forget, write };
}
