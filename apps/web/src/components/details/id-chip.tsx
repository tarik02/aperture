import { Check, Copy } from "lucide-react";
import { useState } from "react";
import * as Effect from "effect/Effect";
import { Tooltip, TooltipContent, TooltipTrigger } from "@aperture-browser/ui/components/tooltip";
import { cn } from "@aperture-browser/ui/utils";
import { copyTextWithToast, useEffectCallback, useFork } from "@aperture-browser/session-react";

const COPY_RESET_MS = 2400;

type IdChipProps = {
  value: string;
  /** What the id belongs to, used in the accessible label, such as "token ID". */
  label?: string;
  className?: string;
};

/** Small monospace chip showing a shortened id; click copies the full value. */
export function IdChip({ value, label = "ID", className }: IdChipProps) {
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
        type="button"
        aria-label={copied ? "Copied" : `Copy ${label} ${value}`}
        onClick={() => handleCopy()}
        className={cn(
          "aperture:inline-flex aperture:h-5 aperture:w-fit aperture:max-w-full aperture:shrink-0 aperture:justify-self-start aperture:items-center aperture:gap-1 aperture:rounded-md aperture:border aperture:bg-muted/50 aperture:px-1.5 aperture:font-mono aperture:text-[11px] aperture:text-muted-foreground aperture:transition-colors aperture:outline-none aperture:hover:bg-muted aperture:hover:text-foreground aperture:focus-visible:ring-[3px] aperture:focus-visible:ring-ring/50",
          className,
        )}
      >
        <span className="aperture:truncate">{shortenId(value)}</span>
        {copied ? (
          <Check className="aperture:size-3 aperture:shrink-0" />
        ) : (
          <Copy className="aperture:size-3 aperture:shrink-0" />
        )}
      </TooltipTrigger>
      <TooltipContent className="aperture:max-w-none aperture:font-mono">
        {copied ? "Copied" : value}
      </TooltipContent>
    </Tooltip>
  );
}

/** Keeps the start and end of a long id, which are the parts people compare. */
export function shortenId(value: string, head = 8, tail = 4) {
  if (value.length <= head + tail + 1) {
    return value;
  }
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}
