import { Button } from "@aperture-browser/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { useLast } from "#/lib/use-last.ts";

type SecretDialogProps = {
  title: string;
  /** The secret, while there is one to show; the dialog is open for as long. */
  secret: string | undefined;
  onClose: () => void;
};

/** Shows a secret the one time it is told: it is kept nowhere it could be read again. */
export function SecretDialog({ title, secret, onClose }: SecretDialogProps) {
  const shown = useLast(secret);
  const copy = async () => {
    await navigator.clipboard.writeText(shown ?? "");
    toast.success("Copied");
  };

  return (
    <Dialog open={secret !== undefined} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Copy it now: it is not shown again.</DialogDescription>
        </DialogHeader>
        <code
          data-console-secret
          className="aperture:block aperture:rounded-lg aperture:bg-muted aperture:p-3 aperture:font-mono aperture:text-xs aperture:break-all"
        >
          {shown}
        </code>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => void copy()}>
            <Copy />
            Copy
          </Button>
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
