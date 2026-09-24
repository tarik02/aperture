import type { ElementHandle, JSHandle, Page } from "playwright-core";
import type * as DocumentHelpers from "./browser/document.js";
import { documentHelpersSource } from "./payload-source.js";
import type { Target } from "./schema.js";

type Helpers = JSHandle<typeof DocumentHelpers>;
type ControlState = NonNullable<Target["documentState"]>["controls"][number];

const loadTimeout = 15_000;
const settleTimeout = 5_000;
const actionTimeout = 2_000;
const reactionDelay = 500;

/**
 * Restores form values, contenteditable content, focus, selection and scroll positions
 * once the page has loaded and gone quiet, so framework hydration no longer overwrites
 * them. Text, checkbox and select values go through Playwright actions, which fire
 * trusted input events that the page's own handlers pick up.
 */
export async function restoreDocument(page: Page, target: Target): Promise<void> {
  const state = target.documentState;
  if (!state && !target.scroll) return;

  await settle(page);
  // The saved state belongs to this exact URL, not to wherever a redirect led.
  if (page.url() !== new URL(target.url).href) return;

  const helpers: Helpers = await page.evaluateHandle(documentHelpersSource());
  try {
    const controls = state?.controls ?? [];
    for (const control of controls) await restoreControl(helpers, control);

    for (const editable of state?.contentEditables ?? []) {
      await helpers.evaluate((h, value) => h.restoreEditable(value), editable);
    }

    // Controls the page reset while reacting to the restored values get one more pass.
    await page.waitForTimeout(reactionDelay);
    for (const control of controls) await restoreControl(helpers, control);

    if (state?.focus) {
      const focus = await resolve(helpers, state.focus);
      await focus?.focus().catch(() => undefined);
      await focus?.dispose();
    }
    if (state?.selection) {
      await helpers.evaluate((h, selection) => h.restoreSelection(selection), state.selection);
    }

    // Last, because filling and focusing controls scrolls them into view.
    await helpers.evaluate((h, { positions, scroll }) => h.restoreScroll(positions, scroll), {
      positions: state?.scrollPositions ?? [],
      scroll: target.scroll,
    });
  } finally {
    await helpers.dispose();
  }
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("load", { timeout: loadTimeout }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: settleTimeout }).catch(() => undefined);
}

async function resolve(
  helpers: Helpers,
  locator: ControlState["locator"],
): Promise<ElementHandle<HTMLElement> | null> {
  const handle = await helpers.evaluateHandle((h, value) => h.resolve(value), locator);
  const element = handle.asElement();
  if (!element) await handle.dispose();
  return element;
}

async function restoreControl(helpers: Helpers, control: ControlState): Promise<void> {
  const element = await resolve(helpers, control.locator);
  if (!element) return;

  try {
    const alreadySet = await helpers.evaluate((h, [el, c]) => h.matches(el, c), [
      element,
      control,
    ] as const);
    if (!alreadySet) {
      const kind = await helpers.evaluate((h, el) => h.controlKind(el), element);
      if (kind === "none") return;
      // Playwright only acts on visible, enabled controls; the rest get native setters.
      const acted =
        kind !== "native" && (await element.isVisible()) && (await act(element, kind, control));
      if (!acted)
        await helpers.evaluate((h, [el, c]) => h.setControl(el, c), [element, control] as const);
    }
    await helpers.evaluate((h, [el, selection]) => h.setSelectionRange(el, selection), [
      element,
      control.selection,
    ] as const);
  } catch {
    // The control was replaced or detached while restoring; the page keeps its own value.
  } finally {
    await element.dispose();
  }
}

async function act(
  element: ElementHandle<HTMLElement>,
  kind: DocumentHelpers.ControlKind,
  control: ControlState,
): Promise<boolean> {
  const options = { timeout: actionTimeout };
  try {
    if (kind === "fill") {
      await element.fill(control.value, options);
    } else if (kind === "check" && control.checked !== undefined) {
      await element.setChecked(control.checked, options);
    } else if (kind === "select") {
      await element.selectOption(
        control.selectedIndices?.map((index) => ({ index })) ?? { value: control.value },
        options,
      );
    } else {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
