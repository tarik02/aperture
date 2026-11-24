import {
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import { FreshDialog } from "#/components/fresh-dialog.tsx";
import { ProviderForm } from "#/features/provider/provider-form.tsx";
import type { Provider } from "#/features/provider/provider.queries.ts";

type ProviderDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The provider that is changed; a new one, without. */
  provider?: Provider | undefined;
  callbackBase: string;
};

/** The provider's form in a dialog: the form knows nothing of what holds it. */
export function ProviderDialog({
  open,
  onOpenChange,
  provider,
  callbackBase,
}: ProviderDialogProps) {
  return (
    <FreshDialog open={open} onOpenChange={onOpenChange} side="right">
      <ProviderForm
        provider={provider}
        callbackBase={callbackBase}
        onDone={() => onOpenChange(false)}
      >
        {({ title, fields, actions }) => (
          <>
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
            </DialogHeader>
            <DialogBody>{fields}</DialogBody>
            <DialogFooter>{actions}</DialogFooter>
          </>
        )}
      </ProviderForm>
    </FreshDialog>
  );
}
