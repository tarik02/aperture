import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Cdp from "./cdp.ts";
import { directory, run } from "./process.ts";
import { chromium } from "./programs.ts";
import { until } from "./wait.ts";

export interface OpenOptions {
  readonly width?: number;
  readonly height?: number;
  /** A phone: touch, and no pointer that hovers. */
  readonly mobile?: boolean;
  readonly scheme?: "light" | "dark";
}

export interface Box {
  /** The middle of the element. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly top: number;
}

/** A page a person has open, driven as a person drives it. */
export interface Page {
  /** Evaluates in the page; a promise is waited for. */
  // oxlint-disable-next-line typescript/no-explicit-any
  readonly evaluate: (expression: string) => Effect.Effect<any, Cdp.CdpError>;
  /** Waits until the expression is truthy in the page. */
  // oxlint-disable-next-line typescript/no-explicit-any
  readonly until: (expression: string, withinMs?: number) => Effect.Effect<any, Error>;
  /** Where the element a selector names is. */
  readonly box: (selector: string) => Effect.Effect<Box, Error>;
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
  readonly click: (selector: string, button?: "left" | "right") => Effect.Effect<void, Error>;
  readonly hover: (selector: string) => Effect.Effect<void, Error>;
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
  readonly open: (url: string, options?: OpenOptions) => Effect.Effect<Page, Error>;
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

export const start = Effect.gen(function* () {
  const profile = yield* directory;
  const browser = yield* run(chromium(), [
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
    30_000,
  );
  const cdp = yield* Cdp.connect(endpoint);

  const open: ViewerService["open"] = (url, options = {}) =>
    Effect.gen(function* () {
      const { width = 1280, height = 800, mobile = false, scheme } = options;
      const { targetId } = yield* cdp.call("Target.createTarget", {
        url: "about:blank",
        newWindow: true,
      });
      const page = yield* cdp.attach(targetId as string);
      const errors: string[] = [];
      cdp.listen((event) => {
        if (event.sessionId === page.sessionId && event.method === "Runtime.exceptionThrown") {
          const thrown = event.params.exceptionDetails;
          errors.push(thrown.exception?.description ?? thrown.text);
        }
      });
      for (const domain of ["Runtime", "Page", "Log", "Network", "DOM"]) {
        yield* page.call(`${domain}.enable`);
      }
      yield* page.call("Emulation.setFocusEmulationEnabled", { enabled: true });
      yield* page.call("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile,
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
          )
          .pipe(
            Effect.flatMap((found: Box | null) =>
              found === null
                ? Effect.fail(new Error(`no element matches ${selector}`))
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
        until: (expression, withinMs) => until(expression, page.evaluate(expression), withinMs),
        box,
        text: (selector) =>
          page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent`),
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
export const snapshot = (page: Page, expression: string) =>
  page.evaluate(
    `(() => { const s = apertureSession.getSnapshot(); const watched = s.targets.find((t) => t.tab === s.selected); return ${expression}; })()`,
  );

/** Waits until the workbench is connected and watches a tab. */
export const ready = (page: Page, members = 1) =>
  page.until(
    `window.apertureSession?.getSnapshot().connection.state === 'open' && apertureSession.getSnapshot().selected !== undefined && (apertureSession.getSnapshot().presence?.members.length ?? 1) >= ${members}`,
    30_000,
  );
