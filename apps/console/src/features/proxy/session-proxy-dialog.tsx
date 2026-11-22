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
  isDraftEmpty,
  type ProxyDraft,
  proxyOf,
  proxyRules,
} from "#/features/proxy/proxy-config.ts";
import { ProxyEditor } from "#/features/proxy/proxy-editor.tsx";
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
      side="right"
      className="aperture:sm:max-w-xl"
    >
      {/* What was kept when the dialog last opened is not what is edited from. */}
      {kept.data === undefined || (open && kept.isFetching) ? (
        <>
          <ProxyHeader />
          <DialogBody height={HEIGHT}>
            <p className="aperture:text-sm aperture:text-muted-foreground">
              {kept.isError ? told(kept.error) : "Asking how it is routed now…"}
            </p>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" disabled>
              Apply
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

/** On a phone: the proxy's field, and the routes with two of them. */
const HEIGHT = "calc(11rem + 5 * var(--control-height))";

function ProxyHeader() {
  return (
    <DialogHeader>
      <DialogTitle>Proxy</DialogTitle>
      <DialogDescription>
        Route this session's browser traffic through an upstream proxy. Changes apply to new
        connections.
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
    onSubmitMeta: { off: false },
    onSubmit: async ({ value, meta }) => {
      try {
        await save.mutateAsync(meta.off ? null : proxyOf(value.proxy));
      } catch {
        // The mutation tells of it.
        return;
      }
      onDone();
    },
  });
  const submitting = useStore(form.store, (state) => state.isSubmitting);
  const submitted = useStore(form.store, (state) => state.submissionAttempts > 0);
  const turningOff = submitting && save.variables === null;

  return (
    <form
      data-console-session-proxy
      noValidate
      className="aperture:contents"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit({ off: false });
      }}
    >
      <ProxyHeader />
      <DialogBody height={HEIGHT}>
        <form.Field name="proxy" validators={{ onSubmit: ({ value }) => proxyRules(value) }}>
          {(field) => (
            <ProxyEditor
              draft={field.state.value}
              errors={submitted ? proxyRules(field.state.value) : undefined}
              disabled={submitting}
              onChange={field.handleChange}
            />
          )}
        </form.Field>
      </DialogBody>
      <DialogFooter>
        {isDraftEmpty(initial) ? null : (
          <Button
            type="button"
            variant="ghost"
            data-console-proxy-off
            className="aperture:text-destructive aperture:hover:text-destructive aperture:sm:mr-auto"
            pending={turningOff}
            disabled={submitting}
            onClick={() => {
              // What is typed is not asked about: none of it is kept.
              form.setFieldValue("proxy", { upstreams: [], rules: [] });
              void form.handleSubmit({ off: true });
            }}
          >
            Turn off proxy
          </Button>
        )}
        <Button type="button" variant="outline" disabled={submitting} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" pending={submitting && !turningOff}>
          Apply
        </Button>
      </DialogFooter>
    </form>
  );
}
