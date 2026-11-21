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
  const position = (event: MouseEvent): Point | undefined => {
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
    return {
      x: (event.clientX - box.left) * (width / box.width),
      y: (event.clientY - box.top) * (height / box.height),
    };
  };

  const focus = () => keys.focus({ preventScroll: true });

  const button = (surface: HTMLElement, pressed: boolean) => (event: PointerEvent) => {
    // A touch does not bring up the phone's keyboard; focusing the keys by hand does.
    if (event.pointerType !== "touch") {
      focus();
    }
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

  const dropped = async (at: Point, files: readonly File[], carried: readonly ClipboardForm[]) => {
    const forms = files.length > 0 ? [await wiring.listed(files)] : carried;
    if (forms.length > 0) {
      send({ case: "drop", value: { ...at, content: { forms: [...forms] } } });
    }
  };

  const pictures: HTMLElement[] = [video, canvas];
  for (const surface of pictures) {
    surface.addEventListener(
      "pointermove",
      (event) => {
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
    surface.addEventListener("pointerdown", button(surface, true), { signal });
    surface.addEventListener("pointerup", button(surface, false), { signal });
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
