import { toast } from "sonner";
import { ApiRequestError } from "#/lib/api/errors.ts";

export function toastMutationError(error: unknown, fallback = "Action failed") {
  if (error instanceof ApiRequestError) {
    toast.error(error.message);
    return;
  }

  toast.error(fallback);
}
