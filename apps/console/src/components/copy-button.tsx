import { Button } from "@aperture-browser/ui/components/button";
import { Check, Copy } from "lucide-react";
import { type ComponentProps, useEffect, useState } from "react";
import { copyText } from "#/lib/copy.ts";

const SHOWN_COPIED_MS = 2400;

type CopyButtonProps = Omit<ComponentProps<typeof Button>, "value" | "onClick" | "children"> & {
  value: string;
  label?: string;
};

/** Copies something, and shows for a moment that it did. */
export function CopyButton({
  value,
  label = "Copy",
  variant = "outline",
  size = "icon-sm",
  ...button
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return undefined;
    }
    const shown = setTimeout(() => setCopied(false), SHOWN_COPIED_MS);
    return () => clearTimeout(shown);
  }, [copied]);

  const copy = async () => {
    if (await copyText(value)) {
      setCopied(true);
    }
  };

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      onClick={() => void copy()}
      {...button}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}
