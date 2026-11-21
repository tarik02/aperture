import { Button } from "@aperture-browser/ui/components/button";
import {
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import { useForm, useStore } from "@tanstack/react-form";
import { FreshDialog } from "#/components/fresh-dialog.tsx";
import {
  draftOf,
  type ProxyDraft,
  ProxyEditor,
  proxyOf,
  proxyRules,
} from "#/features/proxy/proxy-editor.tsx";
import {
  useSessionProxyQuery,
  useSetSessionProxyMutation,
} from "#/features/proxy/proxy.queries.ts";
import { told } from "#/lib/api.ts";

type SessionProxyDialogProps = {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** Changes how a session's connections are routed, while it runs. */
export function SessionProxyDialog({ sessionId, open, onOpenChange }: SessionProxyDialogProps) {
  const kept = useSessionProxyQuery(sessionId, open);

  return (
    <FreshDialog
      open={open}
      onOpenChange={onOpenChange}
      className="aperture:sm:max-w-xl"
      height="26rem"
    >
      {/* What was kept when the dialog last opened is not what is edited from. */}
      {kept.data === undefined || (open && kept.isFetching) ? (
        <>
          <ProxyHeader />
          <DialogBody>
            <p className="aperture:text-sm aperture:text-muted-foreground">
              {kept.isError ? told(kept.error) : "Asking how it is routed now…"}
            </p>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" disabled>
              Save
            </Button>
          </DialogFooter>
        </>
      ) : (
        <ProxyForm
          sessionId={sessionId}
          initial={draftOf(kept.data.proxy)}
          onDone={() => onOpenChange(false)}
        />
      )}
    </FreshDialog>
  );
}

function ProxyHeader() {
  return (
    <DialogHeader>
      <DialogTitle>Routing</DialogTitle>
      <DialogDescription>
        Where the session's browser connections go. It takes effect for new connections.
      </DialogDescription>
    </DialogHeader>
  );
}

function ProxyForm({
  sessionId,
  initial,
  onDone,
}: {
  sessionId: string;
  initial: ProxyDraft;
  onDone: () => void;
}) {
  const save = useSetSessionProxyMutation(sessionId);
  const form = useForm({
    defaultValues: { proxy: initial },
    onSubmit: async ({ value }) => {
      try {
        await save.mutateAsync(proxyOf(value.proxy));
      } catch {
        // The mutation tells of it.
        return;
      }
      onDone();
    },
  });
  const submitting = useStore(form.store, (state) => state.isSubmitting);

  return (
    <form
      data-console-session-proxy
      className="aperture:contents"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <ProxyHeader />
      <DialogBody>
        <form.Field name="proxy" validators={{ onSubmit: ({ value }) => proxyRules(value) }}>
          {(field) => (
            <ProxyEditor
              draft={field.state.value}
              error={field.state.meta.errors.length > 0 ? proxyRules(field.state.value) : undefined}
              onChange={field.handleChange}
            />
          )}
        </form.Field>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}
