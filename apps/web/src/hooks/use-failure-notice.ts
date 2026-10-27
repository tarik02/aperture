import { useEffect, useRef } from "react";
import { toast } from "sonner";

/**
 * Shows one dismissible toast when a query starts failing. It stays quiet on later failed
 * refetches, so a dismissed toast does not come back every poll, and clears once the query
 * recovers.
 */
export function useFailureNotice(id: string, title: string, error: Error | null) {
  const failed = useRef(false);

  useEffect(() => {
    if (error && !failed.current) {
      toast.error(title, { id, description: error.message, duration: Infinity });
    } else if (!error && failed.current) {
      toast.dismiss(id);
    }
    failed.current = error !== null;
  }, [error, id, title]);
}
