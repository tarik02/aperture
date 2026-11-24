import { toast } from "sonner";
import { SessionError, type Session } from "@aperture-browser/session-client";

export interface SessionNotice {
  readonly level: "info" | "error";
  readonly message: string;
  readonly description?: string | undefined;
}

export function showNotice(notice: SessionNotice): void {
  const options = notice.description === undefined ? {} : { description: notice.description };
  if (notice.level === "error") {
    toast.error(notice.message, options);
  } else {
    toast.success(notice.message, options);
  }
}

/** What a failed request to the session says, for a notice's second line. */
export function failureText(cause: unknown): string {
  if (cause instanceof SessionError) {
    return cause.status === 403 ? "Your role in the session does not allow this." : cause.message;
  }
  return cause instanceof Error ? cause.message : "The session could not be reached.";
}

/**
 * Copies text to this browser's clipboard from a click, and tells how it went. A page may
 * always copy text from a click, so a failure is worth a notice.
 */
export function copyTextHere(session: Session, text: string, copied: string): void {
  session.copyHere([{ type: "text/plain", data: new TextEncoder().encode(text) }]).then(
    (written) => {
      showNotice(
        written
          ? { level: "info", message: copied }
          : { level: "error", message: "This browser did not take the copy" },
      );
    },
    () => showNotice({ level: "error", message: "This browser did not take the copy" }),
  );
}

/** Pastes this browser's clipboard into the session, and tells when there was nothing to. */
export function pasteHere(session: Session): void {
  const nothing = (description?: string) =>
    showNotice({ level: "error", message: "Nothing was pasted", description });
  session.paste().then(
    (pasted) => {
      if (!pasted) {
        nothing(
          "This browser's clipboard is empty or may not be read by the page. Paste with the keyboard instead.",
        );
      }
    },
    () => nothing(),
  );
}
