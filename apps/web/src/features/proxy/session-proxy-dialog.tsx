import { useMemo, useState } from "react";
import { CircleAlert } from "lucide-react";
import { toast } from "sonner";
import type { ProxyConfig, Session } from "@aperture-browser/api-client";
import { Alert, AlertDescription } from "@aperture-browser/ui/components/alert";
import { Button } from "@aperture-browser/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import { Label } from "@aperture-browser/ui/components/label";
import { Spinner } from "@aperture-browser/ui/components/spinner";
import { Switch } from "@aperture-browser/ui/components/switch";
import { useUpdateSessionProxyMutation } from "#/features/session/session.mutations.ts";
import {
  draftFromSessionProxy,
  hasProxyDraftErrors,
  isProxyConfigured,
  proxyConfigFromDraft,
  validateProxyDraft,
  type ProxyDraft,
} from "#/features/proxy/proxy-config.ts";
import { ProxyEditor } from "#/features/proxy/proxy-editor.tsx";

const EDITABLE_STATUSES: ReadonlyArray<Session["status"]> = ["creating", "running", "suspended"];
const FORM_ID = "session-proxy-form";

type SessionProxyDialogProps = {
  session: Session | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete?: (open: boolean) => void;
};

export function SessionProxyDialog({
  session,
  open,
  onOpenChange,
  onOpenChangeComplete,
}: SessionProxyDialogProps) {
  const mutation = useUpdateSessionProxyMutation();
  const pending = mutation.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) {
          onOpenChange(next);
        }
      }}
      onOpenChangeComplete={onOpenChangeComplete}
    >
      <DialogContent className="aperture:sm:max-w-2xl" showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>Proxy</DialogTitle>
          <DialogDescription>
            Route this session's browser traffic through an upstream proxy. Changes apply to new
            connections.
          </DialogDescription>
        </DialogHeader>
        {session ? (
          <SessionProxyForm
            session={session}
            mutation={mutation}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function SessionProxyForm({
  session,
  mutation,
  onDone,
}: {
  session: Session;
  mutation: ReturnType<typeof useUpdateSessionProxyMutation>;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState<ProxyDraft>(() => draftFromSessionProxy(session.proxy));
  const [drain, setDrain] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [action, setAction] = useState<"apply" | "off" | null>(null);
  const errors = useMemo(() => validateProxyDraft(draft), [draft]);
  const editable = EDITABLE_STATUSES.includes(session.status);
  const configured = isProxyConfigured(session.proxy);
  const pending = mutation.isPending;
  const disabled = !editable || pending;

  async function save(proxy: ProxyConfig, nextAction: "apply" | "off") {
    setAction(nextAction);
    try {
      await mutation.mutateAsync({
        sessionId: session.id,
        proxy: drain ? { ...proxy, drain: true } : proxy,
      });
    } catch {
      // Shown inline from mutation.error.
      return;
    }
    toast.success(nextAction === "off" ? "Proxy turned off" : "Proxy applied", {
      description:
        session.status === "running" ? undefined : "Takes effect when the session next starts.",
    });
    onDone();
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!editable) {
      return;
    }
    setSubmitted(true);
    if (hasProxyDraftErrors(errors)) {
      return;
    }
    void save(proxyConfigFromDraft(draft), "apply");
  }

  return (
    <>
      <form id={FORM_ID} onSubmit={handleSubmit} className="aperture:flex aperture:flex-col">
        {!editable ? (
          <Alert className="aperture:mb-4">
            <CircleAlert />
            <AlertDescription>
              The proxy can only be changed while the session is running, suspended or starting.
              This session is {session.status}.
            </AlertDescription>
          </Alert>
        ) : null}
        <ProxyEditor
          value={draft}
          onChange={setDraft}
          errors={submitted ? errors : undefined}
          disabled={disabled}
        />
        {mutation.error ? (
          <p role="alert" className="aperture:mt-4 aperture:text-sm aperture:text-destructive">
            {mutation.error.message}
          </p>
        ) : null}
      </form>
      <DialogFooter className="aperture:sm:items-center">
        <Label className="aperture:mr-auto aperture:flex aperture:items-center aperture:gap-2 aperture:font-normal">
          <Switch checked={drain} onCheckedChange={setDrain} disabled={disabled} size="sm" />
          Reset open connections
        </Label>
        {configured ? (
          <Button
            type="button"
            variant="ghost"
            className="aperture:text-destructive aperture:hover:text-destructive"
            onClick={() => void save({}, "off")}
            disabled={disabled}
          >
            {pending && action === "off" ? <Spinner data-icon="inline-start" /> : null}
            Turn off proxy
          </Button>
        ) : null}
        <Button type="button" variant="outline" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" form={FORM_ID} disabled={disabled}>
          {pending && action === "apply" ? <Spinner data-icon="inline-start" /> : null}
          Apply
        </Button>
      </DialogFooter>
    </>
  );
}
