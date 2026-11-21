import { Button } from "@aperture-browser/ui/components/button";
import { Copy } from "lucide-react";
import { toast } from "sonner";

/** Something to copy, shown as it is. */
export function CopyField({ label, value }: { label: string; value: string }) {
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    toast.success("Copied");
  };
  return (
    <div className="aperture:grid aperture:gap-1.5 aperture:text-sm">
      {label}
      <div className="aperture:flex aperture:items-start aperture:gap-2">
        <code className="aperture:min-w-0 aperture:flex-1 aperture:rounded-lg aperture:bg-muted aperture:p-2 aperture:font-mono aperture:text-xs aperture:break-all aperture:whitespace-pre-wrap">
          {value}
        </code>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={`Copy ${label}`}
          onClick={() => void copy()}
        >
          <Copy />
        </Button>
      </div>
    </div>
  );
}
