import { toast } from "sonner";
import { told } from "#/lib/api.ts";

export function toastMutationError(error: unknown, fallback = "Action failed") {
  toast.error(told(error, fallback));
}
