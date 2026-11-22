import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Cdp from "./cdp.ts";
import { directory, run } from "./process.ts";
import { chromium } from "./programs.ts";
import { type TimedOut, until } from "./wait.ts";

export interface OpenOptions {
  readonly width?: number;
  readonly height?: number;
  /** A phone: touch, and no pointer that hovers. */
  readonly mobile?: boolean;
  readonly scheme?: "light" | "dark";
}

/** How a phone with a screen of this shape is held, as the browser is told it is. */
export const held = (width: number, height: number) =>
  width > height
    ? { type: "landscapePrimary" as const, angle: 90 }
    : { type: "portraitPrimary" as const, angle: 0 };

/** Where an element is; `x` and `y` are its middle. */
export const Box = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
  left: Schema.Number,
  top: Schema.Number,
});
export type Box = typeof Box.Type;

/** Nothing in the page is what a check meant to point at. */
export class NoElement extends Schema.TaggedError<NoElement>()("NoElement", {
  sought: Schema.String,
}) {
  override get message() {
    return `no element ${this.sought}`;
  }
}

/** A page a person has open, driven as a person drives it. */
export interface Page {
  /** Evaluates in the page; a promise is waited for. */
  readonly evaluate: Cdp.Evaluate;
  /** Waits until the expression is truthy in the page. */
  readonly until: (expression: string, within?: Duration.Input) => Effect.Effect<unknown, TimedOut>;
  /** Where the element a selector names is. */
  readonly box: (selector: string) => Effect.Effect<Box, Cdp.CdpError | NoElement>;
  readonly text: (selector: string) => Effect.Effect<string | undefined, Cdp.CdpError>;
  readonly mouse: (
    type: "mouseMoved" | "mousePressed" | "mouseReleased" | "mouseWheel",
    x: number,
    y: number,
    more?: object,
  ) => Effect.Effect<void, Cdp.CdpError>;
  readonly clickAt: (
    x: number,
    y: number,
    button?: "left" | "right",
  ) => Effect.Effect<void, Cdp.CdpError>;
  readonly click: (
    selector: string,
    button?: "left" | "right",
  ) => Effect.Effect<void, Cdp.CdpError | NoElement>;
  readonly hover: (selector: string) => Effect.Effect<void, Cdp.CdpError | NoElement>;
  /** Presses and lets go of a key, by what it is called, its code and its virtual key. */
  readonly key: (
    key: string,
    code?: string,
    virtualKey?: number,
  ) => Effect.Effect<void, Cdp.CdpError>;
  /** Types text, key by key. */
  readonly type: (text: string) => Effect.Effect<void, Cdp.CdpError>;
  /** What the page threw so far. */
  readonly errors: () => readonly string[];
  readonly close: Effect.Effect<void, Cdp.CdpError>;
  readonly cdp: Cdp.Attached;
}

/** A browser on this machine that watches sessions, as a person's does. */
export interface ViewerService {
  readonly open: (url: string, options?: OpenOptions) => Effect.Effect<Page, Cdp.CdpError>;
}

const CODES: Record<string, string> = {
  " ": "Space",
  ".": "Period",
  "/": "Slash",
  "-": "Minus",
  ":": "Semicolon",
};
const codeOf = (letter: string) =>
  /[a-z]/iu.test(letter)
    ? `Key${letter.toUpperCase()}`
    : /[0-9]/u.test(letter)
      ? `Digit${letter}`
      : (CODES[letter] ?? "");
const VIRTUAL: Record<string, number> = { ".": 190, "/": 191, "-": 189, ":": 186 };
const virtualOf = (letter: string) =>
  /[a-z0-9 ]/iu.test(letter) ? letter.toUpperCase().charCodeAt(0) : (VIRTUAL[letter] ?? 0);

const Created = Schema.Struct({ targetId: Schema.String });

const Thrown = Schema.Struct({ exceptionDetails: Cdp.ExceptionDetails });
const thrownOf = Schema.decodeUnknownOption(Thrown);

export const start = Effect.gen(function* () {
  const lasting = yield* Effect.scope;
  const profile = yield* directory;
  const browser = yield* run(yield* chromium, [
    "--headless=new",
    "--no-sandbox",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--autoplay-policy=no-user-gesture-required",
    "about:blank",
  ]);
  const endpoint = yield* until(
    "the watching browser serving DevTools",
    Effect.sync(() => /DevTools listening on (ws:\/\/\S+)/u.exec(browser.said())?.[1]),
    "30 seconds",
  );
  const cdp = yield* Cdp.connect(endpoint);

  const open: ViewerService["open"] = (url, options = {}) =>
    Effect.gen(function* () {
      const { width = 1280, height = 800, mobile = false, scheme } = options;
      const { targetId } = yield* cdp.call(
        "Target.createTarget",
        { url: "about:blank", newWindow: true },
        Created,
      );
      const page = yield* cdp.attach(targetId);
      const errors: string[] = [];
      // The page is heard for as long as the browser is there, as it is used: by the
      // checks after the one that opened it.
      const heard = yield* cdp.events.pipe(Effect.provideService(Scope.Scope, lasting));
      yield* Stream.fromSubscription(heard).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.sessionId !== page.sessionId || event.method !== "Runtime.exceptionThrown") {
              return;
            }
            const thrown = Option.getOrUndefined(thrownOf(event.params))?.exceptionDetails;
            errors.push(thrown?.exception?.description ?? thrown?.text ?? "something unreadable");
          }),
        ),
        Effect.forkIn(lasting),
      );
      for (const domain of ["Runtime", "Page", "Log", "Network", "DOM"]) {
        yield* page.call(`${domain}.enable`);
      }
      yield* page.call("Emulation.setFocusEmulationEnabled", { enabled: true });
      yield* page.call("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile,
        // A phone tells how it is held, which a window of its shape alone does not.
        ...(mobile ? { screenOrientation: held(width, height) } : {}),
      });
      if (mobile) {
        yield* page.call("Emulation.setTouchEmulationEnabled", {
          enabled: true,
          maxTouchPoints: 5,
        });
      }
      yield* page.call("Emulation.setEmulatedMedia", {
        features: [
          ...(scheme === undefined ? [] : [{ name: "prefers-color-scheme", value: scheme }]),
          ...(mobile
            ? []
            : [
                { name: "hover", value: "hover" },
                { name: "pointer", value: "fine" },
              ]),
        ],
      });
      const origin = new URL(url).origin;
      yield* cdp.call("Browser.grantPermissions", {
        origin,
        permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
      });
      yield* page.call("Page.navigate", { url });

      const box: Page["box"] = (selector) =>
        page
          .evaluate(
            `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height, left: r.left, top: r.top }; })()`,
            Schema.NullOr(Box),
          )
          .pipe(
            Effect.flatMap((found) =>
              found === null
                ? Effect.fail(new NoElement({ sought: `matches ${selector}` }))
                : Effect.succeed(found),
            ),
          );
      const mouse: Page["mouse"] = (type, x, y, more = {}) =>
        page.call("Input.dispatchMouseEvent", { type, x, y, button: "none", ...more });
      const clickAt: Page["clickAt"] = (x, y, button = "left") =>
        Effect.gen(function* () {
          yield* mouse("mouseMoved", x, y);
          yield* mouse("mousePressed", x, y, {
            button,
            clickCount: 1,
            buttons: button === "right" ? 2 : 1,
          });
          yield* mouse("mouseReleased", x, y, { button, clickCount: 1 });
        });
      const press: Page["key"] = (key, code = key, virtualKey = 0) =>
        Effect.gen(function* () {
          const named = { key, code, windowsVirtualKeyCode: virtualKey };
          yield* page.call("Input.dispatchKeyEvent", {
            type: "rawKeyDown",
            ...named,
            ...(key === "Enter" ? { text: "\r" } : {}),
          });
          if (key === "Enter") {
            yield* page.call("Input.dispatchKeyEvent", { type: "char", key, code, text: "\r" });
          }
          yield* page.call("Input.dispatchKeyEvent", { type: "keyUp", ...named });
        });

      return {
        evaluate: page.evaluate,
        until: (expression, within) => until(expression, page.evaluate(expression), within),
        box,
        text: (selector) =>
          page.evaluate(
            `document.querySelector(${JSON.stringify(selector)})?.textContent`,
            Schema.UndefinedOr(Schema.String),
          ),
        mouse,
        clickAt,
        click: (selector, button) =>
          box(selector).pipe(Effect.flatMap((at) => clickAt(at.x, at.y, button))),
        hover: (selector) =>
          box(selector).pipe(Effect.flatMap((at) => mouse("mouseMoved", at.x, at.y))),
        key: press,
        type: (text) =>
          Effect.forEach(
            Array.from(text),
            (letter) => {
              const named = {
                key: letter,
                code: codeOf(letter),
                windowsVirtualKeyCode: virtualOf(letter),
              };
              return page
                .call("Input.dispatchKeyEvent", { type: "keyDown", text: letter, ...named })
                .pipe(
                  Effect.andThen(page.call("Input.dispatchKeyEvent", { type: "keyUp", ...named })),
                );
            },
            { discard: true },
          ),
        errors: () => errors,
        close: cdp.call("Target.closeTarget", { targetId }),
        cdp: page,
      } satisfies Page;
    });

  return { open } satisfies ViewerService;
});

export class Viewer extends Context.Service<Viewer, ViewerService>()(
  "@aperture-browser/e2e/Viewer",
) {}

/** One watching browser for all the checks of a suite. */
export const layer = Layer.effect(Viewer, start);

/** What a page says of the session it shows, from the session's own snapshot. */
export function snapshot(page: Page, expression: string): Effect.Effect<unknown, Cdp.CdpError>;
export function snapshot<S extends Cdp.Known>(
  page: Page,
  expression: string,
  value: S,
): Effect.Effect<S["Type"], Cdp.CdpError>;
export function snapshot(page: Page, expression: string, value: Cdp.Known = Schema.Unknown) {
  return page.evaluate(
    `(() => { const s = apertureSession.getSnapshot(); const watched = s.targets.find((t) => t.tab === s.selected); return ${expression}; })()`,
    value,
  );
}

/** Waits until the workbench is connected and watches a tab. */
export const ready = (page: Page, members = 1) =>
  page.until(
    `window.apertureSession?.getSnapshot().connection.state === 'open' && apertureSession.getSnapshot().selected !== undefined && (apertureSession.getSnapshot().presence?.members.length ?? 1) >= ${members}`,
    "30 seconds",
  );
