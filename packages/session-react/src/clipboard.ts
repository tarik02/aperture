import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type {
  ClipboardData,
  ClipboardSelection,
  LiveSessionError,
  LiveSessionSelection,
} from "@aperture-browser/live-session";
import { toast } from "sonner";

/** The browser refused to read or write the local clipboard. */
export class ClipboardError extends Data.TaggedError("ClipboardError")<{
  readonly cause?: unknown;
}> {
  override readonly message = "The local clipboard is unavailable";
}

export const copyText = (value: string): Effect.Effect<void, ClipboardError> =>
  Effect.suspend(() => {
    const clipboard = navigator.clipboard;
    if (clipboard?.writeText) {
      return Effect.tryPromise({
        try: () => clipboard.writeText(value),
        catch: (cause) => new ClipboardError({ cause }),
      });
    }

    const textArea = document.createElement("textarea");
    textArea.value = value;
    textArea.readOnly = true;
    textArea.style.position = "fixed";
    textArea.style.top = "0";
    textArea.style.left = "-9999px";

    document.body.append(textArea);
    textArea.select();
    const copied = document.execCommand("copy");
    textArea.remove();

    return copied ? Effect.void : Effect.fail(new ClipboardError({}));
  });

/** Copies `value`, then runs `onCopied`, or shows an error toast if the copy fails. */
export const copyTextWithToast = (value: string, onCopied: () => void = () => {}) =>
  copyText(value).pipe(
    Effect.andThen(Effect.sync(onCopied)),
    Effect.catchTag("ClipboardError", (error) =>
      Effect.sync(() => {
        console.warn("Copy failed", error);
        toast.error("Copy failed");
      }),
    ),
  );

/** Types the local clipboard takes as they are, besides plain text. */
const RICH_TYPES = ["text/html", "image/png"] as const;

/** Names programs offer plain text by, most specific first. */
const TEXT_TYPES = ["text/plain;charset=utf-8", "text/plain", "UTF8_STRING", "STRING", "TEXT"];

const writeClipboardItems = (items: Record<string, Blob>): Effect.Effect<void, ClipboardError> =>
  Effect.tryPromise({
    try: () => navigator.clipboard.write([new ClipboardItem(items)]),
    catch: (cause) => new ClipboardError({ cause }),
  });

/**
 * Copies one of the browser's selections to the local clipboard: its text, read in full when the
 * state only carried the beginning, and its HTML and PNG image when it has them.
 */
export const copyBrowserSelection = (
  selection: LiveSessionSelection,
  kind: ClipboardSelection,
  read: (kind: ClipboardSelection, mimeType: string) => Effect.Effect<Blob, LiveSessionError>,
): Effect.Effect<void, ClipboardError | LiveSessionError> =>
  Effect.gen(function* () {
    const types = selection.types ?? [];
    const textType = TEXT_TYPES.find((type) => types.includes(type));
    const text =
      selection.truncated && textType
        ? yield* read(kind, textType).pipe(
            Effect.flatMap((blob) => Effect.promise(() => blob.text())),
          )
        : selection.text;
    const rich = RICH_TYPES.filter((type) => types.includes(type));
    if (rich.length === 0) {
      return yield* copyText(text);
    }
    const items: Record<string, Blob> = {};
    for (const type of rich) {
      // ClipboardItem wants each blob typed exactly as its key.
      items[type] = new Blob([yield* read(kind, type)], { type });
    }
    if (text !== "") {
      items["text/plain"] = new Blob([text], { type: "text/plain" });
    }
    yield* writeClipboardItems(items);
  });

/** Reads the local clipboard's text, HTML and images; the browser may ask the user first. */
export const readLocalClipboard: Effect.Effect<ClipboardData[], ClipboardError> = Effect.gen(
  function* () {
    const clipboardItems = yield* Effect.tryPromise({
      try: () => navigator.clipboard.read(),
      catch: (cause) => new ClipboardError({ cause }),
    });
    const items: ClipboardData[] = [];
    for (const clipboardItem of clipboardItems) {
      for (const mimeType of clipboardItem.types) {
        const wanted =
          mimeType === "text/plain" || mimeType === "text/html" || mimeType.startsWith("image/");
        if (!wanted || items.some((item) => item.mimeType === mimeType)) {
          continue;
        }
        const data = yield* Effect.tryPromise({
          try: () => clipboardItem.getType(mimeType),
          catch: (cause) => new ClipboardError({ cause }),
        });
        items.push({ mimeType, data });
      }
    }
    return items;
  },
);
