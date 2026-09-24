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
  const compatible = (element: Element): element is HTMLElement =>
    element instanceof HTMLElement &&
    element.localName === locator.tag &&
    (locator.inputType === undefined ||
      (element instanceof HTMLInputElement && element.type === locator.inputType));

  const identity = (
    [
      ["name", locator.name],
      ["autocomplete", locator.autocomplete],
      ["aria-label", locator.ariaLabel],
      ["placeholder", locator.placeholder],
    ] as const
  ).filter(([, value]) => value !== undefined);
  const sameIdentity = (element: Element): boolean =>
    identity.every(([attribute, value]) => element.getAttribute(attribute) === value);

  const candidates = Array.from(document.getElementsByTagName(locator.tag)).filter(compatible);
  if (locator.id !== undefined) {
    const byID = candidates.filter((element) => element.id === locator.id);
    if (byID.length === 1) return byID[0];
  }

  if (identity.length > 0 || locator.inputType !== undefined) {
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
