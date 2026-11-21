import * as Effect from "effect/Effect";
import { form, png, texts } from "./clipboard.ts";
import { MouseButton } from "./gen/aperture/live/v1/live_pb.ts";
import { KEY, KEYS, type Keyboard, US } from "./keys.ts";
import type { ClipboardForm, PictureWay } from "./model.ts";
import type { Outgoing } from "./socket.ts";

/** The elements a session is shown in and takes input from. */
export interface Surfaces {
  /** Shows the picture while it comes as video. */
  readonly video: HTMLVideoElement;
  /** Shows the picture while it comes as frames or as tiles. */
  readonly canvas: HTMLCanvasElement;
  /** Takes the keyboard without showing: what is typed into it goes to the session. */
  readonly keys: HTMLTextAreaElement;
  /** What the picture is laid out in, whose size a fitted viewport follows. */
  readonly stage: HTMLElement;
}

interface Size {
  readonly width: number;
  readonly height: number;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

/** What the wiring needs of the session it wires. */
export interface Wiring {
  readonly send: (message: Outgoing) => void;
  readonly keyboard: Keyboard;
  readonly way: () => PictureWay;
  /** The size of the watched target in logical pixels, which positions are in. */
  readonly watched: () => Size | undefined;
  /** Puts files into the session and gives the form that names them there. */
  readonly listed: (files: readonly File[]) => Promise<ClipboardForm>;
  /** The right button went down at a place, where a menu the session reports is shown. */
  readonly menuAt: (at: Point) => void;
  readonly dismissMenu: () => void;
  /** The stage has another size. */
  readonly resized: () => void;
  readonly failed: (what: string, cause: unknown) => void;
}

/** `MouseEvent.button` to the protocol's buttons. */
const BUTTONS = [
  MouseButton.LEFT,
  MouseButton.MIDDLE,
  MouseButton.RIGHT,
  MouseButton.BACK,
  MouseButton.FORWARD,
];

/** How long the stage has to keep a size before the viewport follows it. */
const RESIZE_SETTLES_MS = 200;

/** Pixels and lines of a wheel to a notch of it. */
const NOTCH = { pixels: 100, lines: 3 };

/** How far a finger may stray, in pixels here, and still be a tap and not a drag. */
const TAP_SLOP = 10;
/** How long a finger rests in place before it is a press of the right button. */
const LONG_PRESS_MS = 500;
/** What a page that was flung keeps of its speed after each millisecond, and where it stops. */
const FLING = { keeps: 0.996, least: 0.05, stops: 0.01 };

/**
 * The part of an element's box its picture covers. An element whose box has not the
 * picture's proportions shows it whole and centred when it is told to contain it, as a
 * `video` is unless told otherwise.
 */
const covered = (view: HTMLElement, picture: Size) => {
  const box = view.getBoundingClientRect();
  const fit = getComputedStyle(view).objectFit;
  const contains = fit === "contain" || fit === "scale-down";
  if (!contains || picture.width === 0 || picture.height === 0) {
    return box;
  }
  const most = fit === "scale-down" ? 1 : Number.POSITIVE_INFINITY;
  const scale = Math.min(box.width / picture.width, box.height / picture.height, most);
  const width = picture.width * scale;
  const height = picture.height * scale;
  return {
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    width,
    height,
  };
};

/**
 * Wires the pointer, the wheel, the keyboard, input methods, the clipboard and dragging
 * of the surfaces to a session. Closing the scope unwires them and releases the keys
 * that are held.
 */
export const wire = Effect.fn("Input.wire")(function* (surfaces: Surfaces, wiring: Wiring) {
  const { video, canvas, keys, stage } = surfaces;
  const { send, keyboard } = wiring;
  const wired = yield* Effect.acquireRelease(
    Effect.sync(() => new AbortController()),
    (controller) =>
      Effect.sync(() => {
        controller.abort();
        keyboard.releaseAll();
      }),
  );
  const { signal } = wired;

  // Positions are in the target's own pixels, whatever size the picture is shown at.
  const position = (event: { readonly clientX: number; readonly clientY: number }) => {
    const shows = wiring.way() === "video";
    const picture = shows
      ? { width: video.videoWidth, height: video.videoHeight }
      : { width: canvas.width, height: canvas.height };
    const box = covered(shows ? video : canvas, picture);
    // The picture may have more pixels than the target has logical ones.
    const { width, height } = wiring.watched() ?? picture;
    if (box.width === 0 || box.height === 0) {
      return undefined;
    }
    const at: Point = {
      x: (event.clientX - box.left) * (width / box.width),
      y: (event.clientY - box.top) * (height / box.height),
    };
    return at;
  };

  const focus = () => keys.focus({ preventScroll: true });

  const button = (surface: HTMLElement, pressed: boolean) => (event: PointerEvent) => {
    focus();
    if (pressed) {
      wiring.dismissMenu();
      surface.setPointerCapture(event.pointerId);
    }
    if (event.button === 2) {
      wiring.menuAt({ x: event.clientX, y: event.clientY });
    }
    const at = position(event);
    const pressedButton = BUTTONS[event.button];
    if (at !== undefined && pressedButton !== undefined) {
      send({ case: "pointerButton", value: { ...at, button: pressedButton, pressed } });
    }
    event.preventDefault();
  };

  /**
   * A finger is no mouse: it has no buttons and nothing to turn. One that is put down and
   * lifted in place is a click of the left button; one that rests is a click of the right;
   * one that moves turns the wheel, so that the page scrolls under it as a page under a
   * finger does, and goes on for a while when it is flung. More fingers move the page as
   * one does: nothing is pressed while they are down.
   */
  const touches = (surface: HTMLElement) => {
    const fingers = new Map<number, { clientX: number; clientY: number }>();
    let gesture:
      | {
          kind: "tap" | "scroll" | "held";
          /** Where it began, here and in the page: the page scrolls what is there. */
          readonly began: { readonly clientX: number; readonly clientY: number };
          readonly at: Point;
          /** The middle of the fingers when they were last looked at. */
          middle: Point | undefined;
          moved: number;
          speed: Point;
        }
      | undefined;
    let resting: ReturnType<typeof setTimeout> | undefined;
    let flung: number | undefined;

    const still = () => {
      clearTimeout(resting);
      if (flung !== undefined) {
        cancelAnimationFrame(flung);
        flung = undefined;
      }
    };
    signal.addEventListener("abort", still);

    /** The middle of the fingers, in the target's pixels. */
    const middle = () => {
      let clientX = 0;
      let clientY = 0;
      for (const finger of fingers.values()) {
        clientX += finger.clientX / fingers.size;
        clientY += finger.clientY / fingers.size;
      }
      return position({ clientX, clientY });
    };

    const click = (at: Point, pressedButton: MouseButton) => {
      send({ case: "pointerMotion", value: at });
      send({ case: "pointerButton", value: { ...at, button: pressedButton, pressed: true } });
      send({ case: "pointerButton", value: { ...at, button: pressedButton, pressed: false } });
    };

    const scroll = (at: Point, by: Point) =>
      send({
        case: "pointerScroll",
        value: { ...at, dx: by.x / NOTCH.pixels, dy: by.y / NOTCH.pixels },
      });

    const fling = (at: Point, speed: Point) => {
      let before = performance.now();
      let going = speed;
      const step = (now: number) => {
        const elapsed = Math.min(now - before, 50);
        before = now;
        const kept = FLING.keeps ** elapsed;
        going = { x: going.x * kept, y: going.y * kept };
        if (Math.hypot(going.x, going.y) < FLING.stops) {
          flung = undefined;
          return;
        }
        scroll(at, { x: going.x * elapsed, y: going.y * elapsed });
        flung = requestAnimationFrame(step);
      };
      flung = requestAnimationFrame(step);
    };

    const down = (event: PointerEvent) => {
      event.preventDefault();
      still();
      wiring.dismissMenu();
      surface.setPointerCapture(event.pointerId);
      fingers.set(event.pointerId, event);
      const at = position(event);
      if (fingers.size > 1 || at === undefined) {
        if (gesture !== undefined) {
          gesture.kind = gesture.kind === "held" ? "held" : "scroll";
          gesture.middle = undefined;
        }
        return;
      }
      const began = { clientX: event.clientX, clientY: event.clientY };
      gesture = { kind: "tap", began, at, middle: at, moved: 0, speed: { x: 0, y: 0 } };
      // The page shows what is under the finger as under a pointer.
      send({ case: "pointerMotion", value: at });
      resting = setTimeout(() => {
        if (gesture?.kind === "tap") {
          gesture.kind = "held";
          wiring.menuAt({ x: began.clientX, y: began.clientY });
          click(at, MouseButton.RIGHT);
        }
      }, LONG_PRESS_MS);
    };

    const move = (event: PointerEvent) => {
      if (gesture === undefined || !fingers.has(event.pointerId)) {
        return;
      }
      fingers.set(event.pointerId, event);
      if (gesture.kind === "tap") {
        const strayed = Math.hypot(
          event.clientX - gesture.began.clientX,
          event.clientY - gesture.began.clientY,
        );
        if (strayed <= TAP_SLOP) {
          return;
        }
        clearTimeout(resting);
        gesture.kind = "scroll";
        gesture.middle = undefined;
      }
      if (gesture.kind !== "scroll") {
        return;
      }
      const now = middle();
      const before = gesture.middle;
      gesture.middle = now;
      if (now === undefined || before === undefined) {
        gesture.moved = event.timeStamp;
        return;
      }
      // The page goes with the finger: what the wheel turns by is the other way.
      const by = { x: before.x - now.x, y: before.y - now.y };
      scroll(gesture.at, by);
      const elapsed = Math.max(event.timeStamp - gesture.moved, 1);
      gesture.moved = event.timeStamp;
      // Evened out over the last moves: the last one alone is no measure of a fling.
      gesture.speed = {
        x: gesture.speed.x * 0.6 + (by.x / elapsed) * 0.4,
        y: gesture.speed.y * 0.6 + (by.y / elapsed) * 0.4,
      };
    };

    const up = (lifted: boolean) => (event: PointerEvent) => {
      if (!fingers.delete(event.pointerId) || gesture === undefined) {
        return;
      }
      event.preventDefault();
      if (fingers.size > 0) {
        gesture.middle = undefined;
        return;
      }
      clearTimeout(resting);
      const ended = gesture;
      gesture = undefined;
      if (!lifted) {
        return;
      }
      if (ended.kind === "tap") {
        click(ended.at, MouseButton.LEFT);
      } else if (
        ended.kind === "scroll" &&
        event.timeStamp - ended.moved < 100 &&
        Math.hypot(ended.speed.x, ended.speed.y) > FLING.least
      ) {
        fling(ended.at, ended.speed);
      }
    };

    return { down, move, up: up(true), cancel: up(false) };
  };

  const dropped = async (at: Point, files: readonly File[], carried: readonly ClipboardForm[]) => {
    const forms = files.length > 0 ? [await wiring.listed(files)] : carried;
    if (forms.length > 0) {
      send({ case: "drop", value: { ...at, content: { forms: [...forms] } } });
    }
  };

  const pictures: HTMLElement[] = [video, canvas];
  for (const surface of pictures) {
    const finger = touches(surface);
    const byFinger = (event: PointerEvent) => event.pointerType === "touch";
    const pressed = button(surface, true);
    const released = button(surface, false);
    surface.addEventListener(
      "pointermove",
      (event) => {
        if (byFinger(event)) {
          finger.move(event);
          return;
        }
        const at = position(event);
        if (at !== undefined) {
          send({ case: "pointerMotion", value: at });
        }
      },
      { signal },
    );
    surface.addEventListener("pointerleave", () => send({ case: "pointerLeave", value: {} }), {
      signal,
    });
    surface.addEventListener(
      "pointerdown",
      (event) => (byFinger(event) ? finger.down(event) : pressed(event)),
      { signal },
    );
    surface.addEventListener(
      "pointerup",
      (event) => (byFinger(event) ? finger.up(event) : released(event)),
      { signal },
    );
    surface.addEventListener(
      "pointercancel",
      (event) => (byFinger(event) ? finger.cancel(event) : undefined),
      { signal },
    );
    surface.addEventListener("contextmenu", (event) => event.preventDefault(), { signal });
    surface.addEventListener(
      "wheel",
      (event) => {
        const at = position(event);
        const notch = event.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? NOTCH.pixels : NOTCH.lines;
        if (at !== undefined) {
          const scrolled = { ...at, dx: event.deltaX / notch, dy: event.deltaY / notch };
          send({ case: "pointerScroll", value: scrolled });
        }
        event.preventDefault();
      },
      { passive: false, signal },
    );
    // What is dropped on the picture is dropped on the page, there.
    surface.addEventListener(
      "dragover",
      (event) => {
        event.preventDefault();
        if (event.dataTransfer !== null) {
          event.dataTransfer.dropEffect = "copy";
        }
      },
      { signal },
    );
    surface.addEventListener(
      "drop",
      (event) => {
        event.preventDefault();
        const at = position(event);
        // What a drag carries is there to read only while its event is handled.
        const carried = event.dataTransfer;
        if (at === undefined || carried === null) {
          return;
        }
        dropped(at, [...carried.files], texts(carried)).catch((cause: unknown) =>
          wiring.failed("a drop", cause),
        );
      },
      { signal },
    );
  }

  // The keyboard. A key goes as the physical key it is where the session's keyboard, a US
  // one, writes the same with it, so that it is held and released as here; a key that
  // writes something else here goes as the text it writes, and so does all that a phone's
  // keyboard or an input method enters.
  const text = (written: string, composing = false) =>
    send({ case: "text", value: { text: written, composing } });

  // A phone's keyboard deletes only what there is to delete.
  const rest = () => {
    keys.value = " ";
  };
  rest();

  keys.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") {
        wiring.dismissMenu();
      }
      // Composing, or a key of a phone's keyboard, which tells no key but 229: the text
      // comes of it.
      if (event.isComposing || event.keyCode === 229) {
        return;
      }
      const code = KEYS[event.code];
      if (code === undefined) {
        return;
      }
      const shortcut = event.ctrlKey || event.metaKey;
      // Pasting comes with what there is to paste.
      if (shortcut && event.code === "KeyV") {
        return;
      }
      const written = Array.from(event.key).length === 1 && !shortcut ? event.key : undefined;
      const same = US[event.code]?.[event.shiftKey ? 1 : 0] === written;
      if (written === undefined || same) {
        keyboard.press(code, true);
      } else {
        text(written);
      }
      event.preventDefault();
    },
    { signal },
  );
  keys.addEventListener(
    "keyup",
    (event) => {
      const code = KEYS[event.code];
      if (code !== undefined) {
        keyboard.press(code, false);
      }
      event.preventDefault();
    },
    { signal },
  );
  keys.addEventListener("blur", () => keyboard.releaseAll(), { signal });
  keys.addEventListener("compositionupdate", (event) => text(event.data, true), { signal });
  keys.addEventListener(
    "compositionend",
    (event) => {
      text(event.data);
      rest();
    },
    { signal },
  );
  keys.addEventListener(
    "beforeinput",
    (event) => {
      if (event.isComposing || /Composition/u.test(event.inputType)) {
        return;
      }
      event.preventDefault();
      if (/^insert(?:Text|ReplacementText)$/u.test(event.inputType) && event.data) {
        text(event.data);
      }
      if (/^insert(?:LineBreak|Paragraph)$/u.test(event.inputType)) {
        keyboard.tap(KEY.enter);
      }
      if (event.inputType === "deleteContentBackward") {
        keyboard.tap(KEY.backspace);
      }
      if (event.inputType === "deleteContentForward") {
        keyboard.tap(KEY.delete);
      }
    },
    { signal },
  );
  keys.addEventListener("input", rest, { signal });

  // The session gets what is pasted here, then the keys that paste there.
  const pasted = async (carried: readonly ClipboardForm[], files: readonly File[]) => {
    const forms = [...carried];
    const [only] = files;
    // One picture is pasted as a picture, which more pages take than take a file.
    const picture = files.length === 1 && only?.type.startsWith("image/") ? only : undefined;
    if (picture !== undefined) {
      forms.push(await form("image/png", await png(picture)));
    } else if (files.length > 0) {
      forms.push(await wiring.listed(files));
    }
    if (forms.length === 0) {
      return;
    }
    send({ case: "clipboard", value: { forms } });
    keyboard.paste();
  };
  keys.addEventListener(
    "paste",
    (event) => {
      event.preventDefault();
      const carried = event.clipboardData;
      if (carried === null) {
        return;
      }
      pasted(texts(carried), [...carried.files]).catch((cause: unknown) =>
        wiring.failed("a paste", cause),
      );
    },
    { signal },
  );

  if (typeof ResizeObserver !== "undefined") {
    let settling: ReturnType<typeof setTimeout> | undefined;
    const sizes = new ResizeObserver(() => {
      clearTimeout(settling);
      settling = setTimeout(wiring.resized, RESIZE_SETTLES_MS);
    });
    sizes.observe(stage);
    signal.addEventListener("abort", () => {
      clearTimeout(settling);
      sizes.disconnect();
    });
  }
});
