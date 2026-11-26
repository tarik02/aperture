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
import { copyText } from "#/lib/copy.ts";
import { useLast } from "#/lib/use-last.ts";

type SecretDialogProps = {
  title: string;
  /** The secret, while there is one to show; the dialog is open for as long. */
  secret: string | undefined;
  /**
   * Whether Escape and a press beside it close it, for a secret that costs nothing to
   * make again. One that does is not taken away by anything done in passing.
   */
  dismissible?: boolean;
  onClose: () => void;
};

/** Shows a secret the one time it is told: it is kept nowhere it could be read again. */
export function SecretDialog({ title, secret, dismissible = false, onClose }: SecretDialogProps) {
  const shown = useLast(secret);
  const copy = async () => {
    if (await copyText(shown ?? "")) {
      toast.success("Copied");
    }
  };

  return (
    <Dialog
      open={secret !== undefined}
      dismissible={dismissible}
      onOpenChange={(open) => (open ? undefined : onClose())}
    >
      <DialogContent className="aperture:sm:max-w-lg" showCloseButton={false}>
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
