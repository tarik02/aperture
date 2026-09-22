import { toast } from "sonner";
import { ApiRequestError } from "@aperture/api-client";

export function toastMutationError(error: unknown, fallback = "Action failed") {
  if (error instanceof ApiRequestError) {
    toast.error(error.message);
    return;
  }

  toast.error(fallback);
}
