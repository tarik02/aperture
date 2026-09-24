import type { ElementHandle, JSHandle, Page } from "playwright-core";
import type * as DocumentHelpers from "./browser/document.js";
import { documentHelpersSource } from "./payload-source.js";
import type { Target } from "./schema.js";

type Helpers = JSHandle<typeof DocumentHelpers>;
type ControlState = NonNullable<Target["documentState"]>["controls"][number];

const loadTimeout = 15_000;
const settleTimeout = 5_000;
const actionTimeout = 5_000;
const reactionDelay = 500;
const appearTimeout = 1_000;

/**
 * Restores form values, contenteditable content, focus, selection and scroll positions
 * once the page has loaded and gone quiet, so framework hydration no longer overwrites
 * them. Values go through Playwright actions so the page's own handlers see them: text
 * fields and checkboxes get trusted input events; selects get the synthetic input and
 * change events Playwright's selectOption dispatches. Native setters, with synthetic
 * events, are only the last resort for controls Playwright cannot act on.
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
    for (const control of controls) await restoreControl(helpers, control, false);

    for (const editable of state?.contentEditables ?? []) {
      await helpers.evaluate((h, value) => h.restoreEditable(value), editable);
    }

    // Second pass: controls the page reset while reacting to the restored values, and
    // controls Playwright could not act on yet. Only now do native setters step in.
    await page.waitForTimeout(reactionDelay);
    for (const control of controls) await restoreControl(helpers, control, true);

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

async function restoreControl(
  helpers: Helpers,
  control: ControlState,
  nativeFallback: boolean,
): Promise<void> {
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
      const acted =
        kind !== "native" && (await act(helpers, element, kind, control, nativeFallback));
      if (!acted && !nativeFallback) return;
      if (!acted) {
        await helpers.evaluate((h, [el, c]) => h.setControl(el, c), [element, control] as const);
      }
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

// Restores a control through Playwright, which only acts on visible elements. On the last
// pass (patient) it gives a control that is still appearing a moment more.
async function act(
  helpers: Helpers,
  element: ElementHandle<HTMLElement>,
  kind: DocumentHelpers.ControlKind,
  control: ControlState,
  patient: boolean,
): Promise<boolean> {
  const options = { timeout: actionTimeout };
  try {
    const visible = patient
      ? await element.waitForElementState("visible", { timeout: appearTimeout }).then(
          () => true,
          () => false,
        )
      : await element.isVisible();

    if (kind === "check" && control.checked !== undefined) {
      if (visible) {
        await element.setChecked(control.checked, options);
        return true;
      }
      // Styled checkboxes often hide the input behind its label; a label click is still a
      // real click on the control.
      const label = await visibleLabel(helpers, element);
      if (!label) return false;
      await label.click(options).finally(() => label.dispose());
      return await helpers.evaluate((h, [el, c]) => h.matches(el, c), [element, control] as const);
    }

    if (!visible) return false;
    if (kind === "fill") {
      await element.fill(control.value, options);
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

async function visibleLabel(
  helpers: Helpers,
  element: ElementHandle<HTMLElement>,
): Promise<ElementHandle<HTMLLabelElement> | null> {
  const handle = await helpers.evaluateHandle((h, el) => h.label(el), element);
  const label = handle.asElement();
  if (label && (await label.isVisible())) return label;
  await handle.dispose();
  return null;
}
