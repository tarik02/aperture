import { useBlocker } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { guardWorkspace } from "#/features/workspace/selected-workspace.ts";

/**
 * Asks before what was changed and not saved is left: for another page, for another
 * workspace where the page is of the one selected, for another tab of the page, or with
 * the browser's own tab. What it gives back asks before it does what it is given.
 */
export function useUnsavedGuard(dirty: boolean, { ofWorkspace }: { ofWorkspace: boolean }) {
  const [pending, setPending] = useState<(() => void) | null>(null);
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => dirty && current.pathname !== next.pathname,
    enableBeforeUnload: dirty,
    withResolver: true,
  });

  useEffect(() => {
    if (!dirty || !ofWorkspace) {
      return;
    }
    return guardWorkspace((go) => setPending(() => go));
  }, [dirty, ofWorkspace]);

  const ask = (go: () => void) => (dirty ? setPending(() => go) : go());
  const asking = pending !== null || blocker.status === "blocked";
  const stay = () => {
    setPending(null);
    blocker.reset?.();
  };

  const dialog = (
    <ConfirmDialog
      open={asking}
      title="Discard unsaved changes?"
      description="What was changed here and not saved is forgotten."
      confirmLabel="Discard changes"
      variant="destructive"
      onOpenChange={(open) => {
        if (!open) {
          stay();
        }
      }}
      onConfirm={() => {
        const go = pending;
        setPending(null);
        if (blocker.status === "blocked") {
          blocker.proceed();
        }
        go?.();
      }}
    />
  );
  return { ask, dialog };
}
