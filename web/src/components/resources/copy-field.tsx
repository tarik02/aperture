import { Copy } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { toast } from "sonner";

type CopyFieldProps = {
  value: string;
  label?: string;
  mono?: boolean;
};

export function CopyField({ value, label, mono = true }: CopyFieldProps) {
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Copied");
    } catch {
      toast.error("Copy failed");
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      {label ? <span className="shrink-0 text-xs text-muted-foreground">{label}</span> : null}
      <Input
        readOnly
        value={value}
        className={mono ? "font-mono text-xs" : "text-xs"}
        onFocus={(event) => event.currentTarget.select()}
      />
      <Button type="button" variant="outline" size="icon-sm" onClick={() => void handleCopy()}>
        <Copy />
      </Button>
    </div>
  );
}
