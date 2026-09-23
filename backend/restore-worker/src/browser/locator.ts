export interface Locator {
  tag: string;
  id?: string;
  name?: string;
  inputType?: string;
  autocomplete?: string;
  ariaLabel?: string;
  placeholder?: string;
  path: { tag: string; index: number }[];
}

export function resolveLocator(locator: Locator): HTMLElement | null {
  const compatible = (element: Element): element is HTMLElement => {
    if (!(element instanceof HTMLElement) || element.localName !== locator.tag) return false;
    if (
      locator.inputType !== undefined &&
      (!(element instanceof HTMLInputElement) || element.type !== locator.inputType)
    ) {
      return false;
    }

    return true;
  };

  const sameIdentity = (element: Element): boolean => {
    if (locator.name !== undefined && element.getAttribute("name") !== locator.name) return false;
    if (
      locator.autocomplete !== undefined &&
      element.getAttribute("autocomplete") !== locator.autocomplete
    ) {
      return false;
    }
    if (
      locator.ariaLabel !== undefined &&
      element.getAttribute("aria-label") !== locator.ariaLabel
    ) {
      return false;
    }
    if (
      locator.placeholder !== undefined &&
      element.getAttribute("placeholder") !== locator.placeholder
    ) {
      return false;
    }

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
    const children = Array.from(current.children).filter((child) => child.localName === step.tag);
    current = children[step.index];
    if (!current) return null;
  }

  return compatible(current) ? current : null;
}
