import { toast } from "sonner";
import type { SessionNotice } from "./hooks/use-browser-control.ts";

export function showNotice(notice: SessionNotice): void {
  if (notice.level === "error") {
    toast.error(notice.message);
  } else {
    toast.success(notice.message);
  }
}
