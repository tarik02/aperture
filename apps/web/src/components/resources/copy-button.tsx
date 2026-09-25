import { Check, Copy } from "lucide-react";
import type { ReactElement } from "react";
import { useState } from "react";
import * as Effect from "effect/Effect";
import { Button } from "@aperture-browser/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@aperture-browser/ui/components/tooltip";
import { copyTextWithToast, useEffectCallback, useFork } from "@aperture-browser/session-react";

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
