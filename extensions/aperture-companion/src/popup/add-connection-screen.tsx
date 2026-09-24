import { Button } from "@aperture/ui/components/button";
import { Field, FieldGroup, FieldLabel } from "@aperture/ui/components/field";
import { Input } from "@aperture/ui/components/input";
import { Spinner } from "@aperture/ui/components/spinner";
import { ArrowLeftIcon } from "lucide-react";
import { StatusAlert } from "./status.tsx";
import type { Popup } from "./use-popup.ts";

/** Connects to an Aperture instance; the first screen until a connection exists. */
export function AddConnectionScreen({ popup }: { popup: Popup }) {
  const { connectionDraft: draft, busy, connecting, actions } = popup;
  const firstConnection = popup.connection === null;

  return (
    <>
      <header className="flex items-center gap-2">
        {firstConnection ? (
          <img src="/icon.svg" alt="Aperture" className="size-8 shrink-0" />
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Back"
            title="Back"
            disabled={busy}
            onClick={() => actions.showScreen("home")}
          >
            <ArrowLeftIcon />
          </Button>
        )}
        <h1 className="text-base font-semibold">
          {firstConnection ? "Connect to Aperture" : "Add connection"}
        </h1>
      </header>
      <form className="flex flex-1 flex-col" onSubmit={(event) => void actions.connect(event)}>
        <FieldGroup className="flex-1 gap-3">
          <Field>
            <FieldLabel htmlFor="origin">Aperture URL</FieldLabel>
            <Input
              id="origin"
              type="url"
              value={draft.origin}
              placeholder="https://aperture.example.com"
              required
              disabled={busy}
              onChange={(event) =>
                actions.updateConnectionDraft({ ...draft, origin: event.target.value })
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="token">API token</FieldLabel>
            <Input
              id="token"
              type="password"
              value={draft.token}
              autoComplete="off"
              placeholder="apt_…"
              required
              disabled={busy}
              onChange={(event) =>
                actions.updateConnectionDraft({ ...draft, token: event.target.value })
              }
            />
          </Field>
          <StatusAlert status={popup.status} />
          <Button className="mt-auto" type="submit" disabled={busy}>
            {connecting ? <Spinner data-icon="inline-start" /> : null}
            {connecting ? "Connecting…" : "Add connection"}
          </Button>
        </FieldGroup>
      </form>
    </>
  );
}
