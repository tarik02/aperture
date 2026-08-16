import { Check, Copy } from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import { timer } from "rxjs";
import { toast } from "sonner";
import { Button } from "#/components/ui/button.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "#/components/ui/tooltip.tsx";

type CopyButtonProps = {
  value: string;
  label?: string;
  className?: string;
  disabled?: boolean;
  render?: ReactElement;
};

const COPY_RESET_MS = 2400;

export function CopyButton({
  value,
  label = "Copy",
  className,
  disabled,
  render,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }

    const subscription = timer(COPY_RESET_MS).subscribe(() => {
      setCopied(false);
    });
    return () => subscription.unsubscribe();
  }, [copied]);

  async function handleCopy() {
    try {
      await copyText(value);
      setCopied(true);
    } catch (error) {
      console.warn("Copy failed", error);
      toast.error("Copy failed");
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={render ?? <Button variant="outline" size="icon-sm" />}
        type="button"
        className={className}
        aria-label={copied ? "Copied" : label}
        disabled={disabled}
        onClick={() => void handleCopy()}
      >
        {copied ? <Check /> : <Copy />}
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : label}</TooltipContent>
    </Tooltip>
  );
}

export async function copyText(value: string) {
  const clipboard = navigator.clipboard;
  if (clipboard?.writeText) {
    await clipboard.writeText(value);
    return;
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

  if (!copied) {
    throw new Error("clipboard write is unavailable");
  }
}
