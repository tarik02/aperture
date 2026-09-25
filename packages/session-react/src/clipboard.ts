import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { toast } from "sonner";

/** The browser refused to write to the clipboard. */
export class ClipboardError extends Data.TaggedError("ClipboardError")<{
  readonly cause?: unknown;
}> {
  override readonly message = "Clipboard write is unavailable";
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
