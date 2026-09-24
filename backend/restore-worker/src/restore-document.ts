import { Effect } from "effect";
import type { Playwright } from "effect-playwright";
import type { ElementHandle, JSHandle } from "playwright-core";
import type * as DocumentHelpers from "./browser/document.js";
import { attempt } from "./cdp.js";
import { PayloadSource } from "./payload-source.js";
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
export const restoreDocument = Effect.fnUntraced(function* (page: Playwright.Page, target: Target) {
  const state = target.documentState;
  if (!state && !target.scroll) return;

  yield* settle(page);
  // The saved state belongs to this exact URL, not to wherever a redirect led.
  if (page.url() !== new URL(target.url).href) return;

  const payloads = yield* PayloadSource;
  const helpers: Helpers = yield* Effect.acquireRelease(
    page.use((raw) => raw.evaluateHandle(payloads.documentHelpers()) as Promise<Helpers>),
    (helpers) => Effect.ignore(attempt(() => helpers.dispose())),
  );

  const controls = state?.controls ?? [];
  for (const control of controls) yield* restoreControl(helpers, control, false);

  for (const editable of state?.contentEditables ?? []) {
    yield* attempt(() => helpers.evaluate((h, value) => h.restoreEditable(value), editable));
  }

  // Second pass: controls the page reset while reacting to the restored values, and
  // controls Playwright could not act on yet. Only now do native setters step in.
  yield* Effect.sleep(reactionDelay);
  for (const control of controls) yield* restoreControl(helpers, control, true);

  if (state?.focus) {
    const focus = yield* resolve(helpers, state.focus);
    if (focus) {
      yield* Effect.ignore(attempt(() => focus.focus()));
      yield* attempt(() => focus.dispose());
    }
  }
  const selection = state?.selection;
  if (selection) {
    yield* attempt(() => helpers.evaluate((h, value) => h.restoreSelection(value), selection));
  }

  // Last, because filling and focusing controls scrolls them into view.
  yield* attempt(() =>
    helpers.evaluate((h, { positions, scroll }) => h.restoreScroll(positions, scroll), {
      positions: state?.scrollPositions ?? [],
      scroll: target.scroll,
    }),
  );
}, Effect.scoped);

const settle = (page: Playwright.Page) =>
  Effect.gen(function* () {
    yield* Effect.ignore(page.waitForLoadState("load", { timeout: loadTimeout }));
    yield* Effect.ignore(page.waitForLoadState("networkidle", { timeout: settleTimeout }));
  });

const resolve = Effect.fnUntraced(function* (helpers: Helpers, locator: ControlState["locator"]) {
  const handle = yield* attempt(() =>
    helpers.evaluateHandle((h, value) => h.resolve(value), locator),
  );
  const element = handle.asElement();
  if (!element) yield* attempt(() => handle.dispose());
  return element;
});

const restoreControl = (helpers: Helpers, control: ControlState, nativeFallback: boolean) =>
  Effect.gen(function* () {
    const element = yield* resolve(helpers, control.locator);
    if (!element) return;

    yield* Effect.gen(function* () {
      const alreadySet = yield* attempt(() =>
        helpers.evaluate((h, [el, c]) => h.matches(el, c), [element, control] as const),
      );
      if (!alreadySet) {
        const kind = yield* attempt(() => helpers.evaluate((h, el) => h.controlKind(el), element));
        if (kind === "none") return;
        const acted =
          kind !== "native" && (yield* act(helpers, element, kind, control, nativeFallback));
        if (!acted && !nativeFallback) return;
        if (!acted) {
          yield* attempt(() =>
            helpers.evaluate((h, [el, c]) => h.setControl(el, c), [element, control] as const),
          );
        }
      }
      yield* attempt(() =>
        helpers.evaluate((h, [el, selection]) => h.setSelectionRange(el, selection), [
          element,
          control.selection,
        ] as const),
      );
    }).pipe(
      // The control was replaced or detached while restoring; the page keeps its own value.
      Effect.ignore,
      Effect.ensuring(Effect.ignore(attempt(() => element.dispose()))),
    );
  });

// Restores a control through Playwright, which only acts on visible elements. On the last
// pass (patient) it gives a control that is still appearing a moment more.
const act = (
  helpers: Helpers,
  element: ElementHandle<HTMLElement>,
  kind: DocumentHelpers.ControlKind,
  control: ControlState,
  patient: boolean,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const options = { timeout: actionTimeout };
    const visible = patient
      ? yield* attempt(() =>
          element.waitForElementState("visible", { timeout: appearTimeout }),
        ).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        )
      : yield* attempt(() => element.isVisible());

    if (kind === "check" && control.checked !== undefined) {
      if (visible) {
        yield* attempt(() => element.setChecked(control.checked!, options));
        return true;
      }
      // Styled checkboxes often hide the input behind its label; a label click is still a
      // real click on the control.
      const label = yield* visibleLabel(helpers, element);
      if (!label) return false;
      yield* attempt(() => label.click(options)).pipe(
        Effect.ensuring(Effect.ignore(attempt(() => label.dispose()))),
      );
      return yield* attempt(() =>
        helpers.evaluate((h, [el, c]) => h.matches(el, c), [element, control] as const),
      );
    }

    if (!visible) return false;
    if (kind === "fill") {
      yield* attempt(() => element.fill(control.value, options));
    } else if (kind === "select") {
      const values = control.selectedIndices?.map((index) => ({ index })) ?? {
        value: control.value,
      };
      yield* attempt(() => element.selectOption(values, options));
    } else {
      return false;
    }
    return true;
  }).pipe(Effect.orElseSucceed(() => false));

const visibleLabel = Effect.fnUntraced(function* (
  helpers: Helpers,
  element: ElementHandle<HTMLElement>,
) {
  const handle = yield* attempt(() => helpers.evaluateHandle((h, el) => h.label(el), element));
  const label = handle.asElement();
  if (label && (yield* attempt(() => label.isVisible()))) return label;
  yield* attempt(() => handle.dispose());
  return null;
});
