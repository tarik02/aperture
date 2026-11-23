import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Cdp from "./cdp.ts";
import * as Failures from "./failures.ts";
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

/** What keeps an element from being pressed, as the page tells it. */
const Aim = Schema.Union([Box, Schema.Struct({ not: Schema.String })]);

/**
 * Where an element is pressed: its middle, once the element is there, neither it nor what
 * it stands in is on its way somewhere, and a press at its middle is one of it. Something
 * that slides or grows into place is elsewhere by the time a press aimed at where it was
 * lands, and how long it takes to come to rest is the machine's to say: on a busy one a
 * transition of 300 ms was seen to take 850. What moves for as long as it is there, as what
 * pulses does, is not waited for.
 */
const aimAt = (element: string, pressed: boolean) => `(() => {
  const element = ${element};
  if (!element) return { not: "there" };
  const moving = document.getAnimations().find((one) => {
    const target = one.effect?.target;
    return (
      one.playState === "running" &&
      Number.isFinite(Number(one.effect?.getComputedTiming().endTime)) &&
      target != null &&
      target.contains(element)
    );
  });
  if (moving) return { not: "at rest" };
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const root = element.getRootNode();
  const hit = (typeof root.elementFromPoint === "function" ? root : document).elementFromPoint(x, y);
  // What takes no presses itself is pressed for what is under it.
  const pressed = ${pressed} && getComputedStyle(element).pointerEvents !== "none";
  if (pressed && hit === null) return { not: "in the window" };
  if (pressed && !element.contains(hit) && !(hit.shadowRoot?.contains(element) ?? false)) {
    const named = [hit.tagName.toLowerCase(), ...[...hit.attributes].slice(0, 4).map((one) => "[" + one.name + (one.value === "" ? "" : '="' + one.value.slice(0, 40) + '"') + "]")].join("");
    return { not: "under nothing else: " + named + " is over it" };
  }
  return { x, y, width: rect.width, height: rect.height, left: rect.left, top: rect.top };
})()`;

/** A place in a page's window. */
export interface Place {
  readonly x: number;
  readonly y: number;
}

/** The places a finger is told at on its way from one to another, the first where it is put down. */
export const along = (from: Place, to: Place, steps = 10): readonly [Place, ...Place[]] => [
  from,
  ...Array.from({ length: steps }, (_, step) => ({
    x: from.x + ((to.x - from.x) * (step + 1)) / steps,
    y: from.y + ((to.y - from.y) * (step + 1)) / steps,
  })),
];

/** How long a finger takes from one place it is told at to the next. */
const FRAME = Duration.millis(16);

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
  /**
   * Where the element an expression gives in the page is pressed, once it can be: it is
   * there, at rest, and nothing else is over its middle.
   */
  readonly aim: (element: string) => Effect.Effect<Box, NoElement>;
  /**
   * Where the element an expression gives in the page is, once it is there and at rest:
   * for what is looked at or measured where it stays, and may take no press.
   */
  readonly rests: (element: string) => Effect.Effect<Box, NoElement>;
  /** Clicks the element a selector names, once it can be pressed. */
  readonly click: (
    selector: string,
    button?: "left" | "right",
  ) => Effect.Effect<void, Cdp.CdpError | NoElement>;
  /** Clicks the element an expression gives in the page, once it can be pressed. */
  readonly clickOn: (element: string) => Effect.Effect<void, Cdp.CdpError | NoElement>;
  /** Puts a finger down and lifts it where it went down. */
  readonly tapAt: (x: number, y: number) => Effect.Effect<void, Cdp.CdpError>;
  /**
   * Puts a finger down at the first place, moves it through the others a frame apart and
   * lifts it, after `rests` where it is to rest first: a finger that rests before it is
   * lifted flings nothing on.
   */
  readonly finger: (
    path: readonly [Place, ...Place[]],
    rests?: Duration.Input,
  ) => Effect.Effect<void, Cdp.CdpError>;
  /** Taps the element a selector names with a finger, once it can be pressed. */
  readonly tap: (selector: string) => Effect.Effect<void, Cdp.CdpError | NoElement>;
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

/** How long something that is to be pressed gets to be there and at rest. */
const PRESSED_WITHIN = "15 seconds";

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
const Shot = Schema.Struct({ data: Schema.String });

/** Where a page is, how large, what has the keyboard, and what it knows of its session. */
const TOLD_OF_A_PAGE = `(() => {
  const focused = document.activeElement;
  let session = "none";
  try {
    session = JSON.stringify(window.apertureSession?.getSnapshot() ?? "none", null, 2);
  } catch (error) {
    session = String(error);
  }
  return [
    "at: " + location.href,
    "window: " + innerWidth + "x" + innerHeight,
    "focused: " + (focused === null ? "nothing" : focused.outerHTML.slice(0, 300)),
    "session: " + session,
  ].join("\\n");
})()`;

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

  // The pages that are open, in the order they were opened, for telling of a check that fails.
  const pages = new Map<number, { readonly page: Cdp.Attached; readonly errors: string[] }>();
  let opened = 0;
  const told = <E>(tells: Effect.Effect<Failures.Kept, E>) =>
    tells.pipe(
      Effect.map((kept) => [kept]),
      Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.succeed([]) }),
      Effect.orElseSucceed((): ReadonlyArray<Failures.Kept> => []),
    );
  yield* Failures.witness(
    Effect.suspend(() =>
      Effect.forEach([...pages], ([number, { page, errors }]) =>
        Effect.all(
          [
            told(
              page.call("Page.captureScreenshot", { format: "png" }, Shot).pipe(
                Effect.flatMap((shot) => Effect.fromResult(Base64.decode(shot.data))),
                Effect.map((content) => ({ name: `page-${number}.png`, content })),
              ),
            ),
            told(
              page
                .evaluate("document.documentElement.outerHTML", Schema.String)
                .pipe(Effect.map((content) => ({ name: `page-${number}.html`, content }))),
            ),
            told(
              page.evaluate(TOLD_OF_A_PAGE, Schema.String).pipe(
                Effect.map((content) => ({
                  name: `page-${number}.txt`,
                  content: `${content}\n\nthrown:\n${errors.join("\n")}\n`,
                })),
              ),
            ),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.map((kept) => kept.flat())),
      ),
    ).pipe(Effect.map((kept) => kept.flat())),
  );

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
      opened += 1;
      const number = opened;
      pages.set(number, { page, errors });
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
      const placed = (element: string, pressed: boolean) =>
        Effect.suspend(() => {
          let not = "there";
          return until(
            `${element} being where it is pressed`,
            page.evaluate(aimAt(element, pressed), Aim).pipe(
              Effect.map((seen) => {
                if ("not" in seen) {
                  not = seen.not;
                  return undefined;
                }
                return seen;
              }),
            ),
            PRESSED_WITHIN,
          ).pipe(
            Effect.mapError(
              () =>
                new NoElement({
                  sought: `${pressed ? "to press" : "at rest"} is ${element}: it is not ${not}`,
                }),
            ),
          );
        });
      const aim: Page["aim"] = (element) => placed(element, true);
      const named = (selector: string) => `document.querySelector(${JSON.stringify(selector)})`;
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
      // What a finger does next after it is put down is told to the browser a frame later,
      // whatever the browser has answered by then: how long the finger rests where it
      // went down is then how long it is told to, not how long an answer takes to come
      // back. One that rests half a second is a long press to what it touches, and an
      // answer takes as long on a machine that is busy. The moves after the first are
      // each told once the one before is answered, as the browser makes one move of
      // those it has not answered yet.
      const finger: Page["finger"] = (path, rests = Duration.zero) =>
        Effect.gen(function* () {
          const told = (type: string, at?: Place) =>
            page.call("Input.dispatchTouchEvent", {
              type,
              touchPoints: at === undefined ? [] : [at],
            });
          const [began, first, ...moves] = path;
          const lifted = Effect.sleep(rests).pipe(Effect.andThen(told("touchEnd")));
          const next = first === undefined ? lifted : told("touchMove", first);
          yield* Effect.all([told("touchStart", began), next.pipe(Effect.delay(FRAME))], {
            concurrency: "unbounded",
            discard: true,
          });
          if (first === undefined) {
            return;
          }
          for (const at of moves) {
            yield* Effect.sleep(FRAME);
            yield* told("touchMove", at);
          }
          yield* lifted;
        });
      const tapAt: Page["tapAt"] = (x, y) => finger([{ x, y }]);
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
        aim,
        rests: (element) => placed(element, false),
        click: (selector, button) =>
          aim(named(selector)).pipe(Effect.flatMap((at) => clickAt(at.x, at.y, button))),
        clickOn: (element) => aim(element).pipe(Effect.flatMap((at) => clickAt(at.x, at.y))),
        tapAt,
        finger,
        tap: (selector) => aim(named(selector)).pipe(Effect.flatMap((at) => tapAt(at.x, at.y))),
        hover: (selector) =>
          aim(named(selector)).pipe(Effect.flatMap((at) => mouse("mouseMoved", at.x, at.y))),
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
        close: Effect.suspend(() => {
          pages.delete(number);
          return cdp.call("Target.closeTarget", { targetId });
        }),
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
