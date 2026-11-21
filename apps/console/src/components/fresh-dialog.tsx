import { Dialog, DialogContent } from "@aperture-browser/ui/components/dialog";
import { Fragment, useState } from "react";

type FreshDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
  /** How tall it stays, where what it holds changes while it is open. */
  height?: string;
  /** What has the focus once it has closed, where that is not what had it before. */
  finalFocus?: React.RefObject<HTMLElement | null> | undefined;
  children: React.ReactNode;
};

/**
 * A dialog whose content starts anew each time it opens, and stays as it was left until the
 * dialog has closed: what closes it does not empty it while it is still seen.
 */
export function FreshDialog({
  open,
  onOpenChange,
  className,
  height,
  finalFocus,
  children,
}: FreshDialogProps) {
  const [shown, setShown] = useState(open);
  const [opened, setOpened] = useState(0);
  if (open && !shown) {
    setShown(true);
    setOpened(opened + 1);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(next) => {
        if (!next) {
          setShown(false);
        }
      }}
    >
      <DialogContent className={className} height={height} finalFocus={finalFocus}>
        {shown ? <Fragment key={opened}>{children}</Fragment> : null}
      </DialogContent>
    </Dialog>
  );
}
