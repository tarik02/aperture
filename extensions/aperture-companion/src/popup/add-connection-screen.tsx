import { Button } from "@aperture-browser/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@aperture-browser/ui/components/field";
import { Input } from "@aperture-browser/ui/components/input";
import { Spinner } from "@aperture-browser/ui/components/spinner";
import { ArrowLeftIcon } from "lucide-react";
import { StatusAlert } from "./status.tsx";
import type { Popup } from "./use-popup.ts";

/** Connects to an Aperture instance; the first screen until a connection exists. */
export function AddConnectionScreen({ popup }: { popup: Popup }) {
  const { connectionDraft: draft, busy, connecting, actions } = popup;
  const firstConnection = popup.connection === null;

  return (
    <>
      <header className="aperture:flex aperture:items-center aperture:gap-2">
        {firstConnection ? (
          <img src="/icon.svg" alt="Aperture" className="aperture:size-8 aperture:shrink-0" />
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
        <h1 className="aperture:text-base aperture:font-semibold">
          {firstConnection ? "Connect to Aperture" : "Add connection"}
        </h1>
      </header>
      <form
        className="aperture:flex aperture:flex-1 aperture:flex-col"
        onSubmit={(event) => void actions.connect(event)}
      >
        <FieldGroup className="aperture:flex-1 aperture:gap-3">
          <Field data-disabled={busy}>
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
          {draft.method === "token" ? (
            <Field data-disabled={busy}>
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
          ) : (
            <FieldDescription>
              Sign in on Aperture and approve access. Manage or revoke it later in Connected apps.
            </FieldDescription>
          )}
          <StatusAlert status={popup.status} />
          <Button className="aperture:mt-auto" type="submit" disabled={busy}>
            {connecting ? <Spinner data-icon="inline-start" /> : null}
            {connecting
              ? "Connecting…"
              : draft.method === "oauth"
                ? "Connect with Aperture"
                : "Connect with API token"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              actions.updateConnectionDraft({
                ...draft,
                method: draft.method === "oauth" ? "token" : "oauth",
              })
            }
          >
            {draft.method === "oauth" ? "Use API token instead" : "Use site login instead"}
          </Button>
        </FieldGroup>
      </form>
    </>
  );
}
