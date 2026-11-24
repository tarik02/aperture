import { Button } from "@aperture-browser/ui/components/button";
import { hostsOf } from "../chrome.ts";
import type { PendingCommand } from "../pending-command.ts";
import { StatusAlert } from "./status.tsx";
import type { Popup } from "./use-popup.ts";

/**
 * In place of the other screens while a command waits for sites the extension was not
 * given and nothing asks for them any more: the browser's prompt was dismissed, or the
 * popup closed over it. One press asks again; the other takes the command back.
 */
export function AccessScreen({ popup, awaiting }: { popup: Popup; awaiting: PendingCommand }) {
  const teleport = awaiting.command.type === "teleport-tabs";

  return (
    <>
      <header className="aperture:flex aperture:items-center aperture:gap-2">
        <img src="/icon.svg" alt="Aperture" className="aperture:size-8 aperture:shrink-0" />
        <h1 className="aperture:text-base aperture:font-semibold">Site access is needed</h1>
      </header>
      <p
        data-companion-access={awaiting.command.type}
        className="aperture:text-sm aperture:text-muted-foreground"
      >
        {teleport
          ? "The teleport waits for access to the pages' sites, which was not given: "
          : "The connection waits for access to Aperture, which was not given: "}
        <span className="aperture:text-foreground aperture:wrap-anywhere">
          {hostsOf(awaiting.origins).join(", ")}
        </span>
        .
      </p>
      <StatusAlert status={popup.status} />
      <footer className="aperture:mt-auto aperture:flex aperture:gap-2">
        <Button
          type="button"
          variant="outline"
          className="aperture:flex-1"
          disabled={popup.askingAccess}
          onClick={() => void popup.actions.cancelAccess()}
        >
          Cancel
        </Button>
        <Button
          type="button"
          className="aperture:flex-1"
          pending={popup.askingAccess}
          onClick={() => void popup.actions.giveAccess()}
        >
          Give access
        </Button>
      </footer>
    </>
  );
}
