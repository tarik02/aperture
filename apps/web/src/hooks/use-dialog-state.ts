import { useCallback, useMemo, useState } from "react";

export interface DialogState<T> {
  /** What the dialog shows. It outlives `open` until the exit animation ends. */
  readonly data: T | null;
  readonly open: boolean;
  /** Changes on every `show`, so a dialog keyed by it starts with fresh form state. */
  readonly key: number;
  readonly show: (data: T) => void;
  readonly close: () => void;
  /** Props for a Base UI Dialog root. */
  readonly rootProps: {
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    readonly onOpenChangeComplete: (open: boolean) => void;
  };
}

/**
 * Keeps a dialog's payload apart from its open flag, so the content stays rendered while the
 * dialog animates out, and clears the payload once it has.
 */
export function useDialogState<T>(): DialogState<T> {
  const [state, setState] = useState<{ data: T | null; open: boolean; key: number }>({
    data: null,
    open: false,
    key: 0,
  });

  const show = useCallback((data: T) => {
    setState((current) => ({ data, open: true, key: current.key + 1 }));
  }, []);
  const close = useCallback(() => {
    setState((current) => (current.open ? { ...current, open: false } : current));
  }, []);
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        close();
      }
    },
    [close],
  );
  const onOpenChangeComplete = useCallback((open: boolean) => {
    if (!open) {
      setState((current) => (current.open ? current : { ...current, data: null }));
    }
  }, []);

  return useMemo(
    () => ({
      data: state.data,
      open: state.open,
      key: state.key,
      show,
      close,
      rootProps: { open: state.open, onOpenChange, onOpenChangeComplete },
    }),
    [state, show, close, onOpenChange, onOpenChangeComplete],
  );
}
