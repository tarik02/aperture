import { Check, Copy } from "lucide-react";
import type { ReactElement } from "react";
import { useState } from "react";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { toast } from "sonner";
import { Button } from "@aperture/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@aperture/ui/components/tooltip";
import { useEffectCallback, useFork } from "#/lib/effect/react.tsx";

interface CopyButtonProps {
  value: string;
  label?: string;
  className?: string;
  disabled?: boolean;
  render?: ReactElement;
}

const COPY_RESET_MS = 2400;

export function CopyButton({
  value,
  label = "Copy",
  className,
  disabled,
  render,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  useFork(
    () =>
      copied
        ? Effect.sleep(COPY_RESET_MS).pipe(Effect.andThen(Effect.sync(() => setCopied(false))))
        : undefined,
    [copied],
  );

  const handleCopy = useEffectCallback(
    () => copyTextWithToast(value, () => setCopied(true)),
    [value],
  );

  return (
    <Tooltip>
      <TooltipTrigger
        render={render ?? <Button variant="outline" size="icon-sm" />}
        type="button"
        className={className}
        aria-label={copied ? "Copied" : label}
        disabled={disabled}
        onClick={() => handleCopy()}
      >
        {copied ? <Check /> : <Copy />}
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : label}</TooltipContent>
    </Tooltip>
  );
}

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
