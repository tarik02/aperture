import { Button } from "@aperture-browser/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { draftOf, type ProxyDraft, ProxyEditor, proxyOf } from "#/features/proxy/proxy-editor.tsx";
import { call } from "#/lib/api.ts";
import { toastMutationError } from "#/lib/mutation-toast.ts";
import { queryKeys } from "#/lib/query-keys.ts";

type SessionProxyDialogProps = {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** Changes how a session's connections are routed, while it runs. */
export function SessionProxyDialog({ sessionId, open, onOpenChange }: SessionProxyDialogProps) {
  const kept = useQuery({
    queryKey: queryKeys.proxy(sessionId),
    queryFn: () => call((api) => api.sessions.proxy({ params: { id: sessionId } })),
    enabled: open,
    // Edited from what is kept now, and not from what was when the dialog last opened.
    gcTime: 0,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {open && kept.data !== undefined ? (
          <ProxyForm
            sessionId={sessionId}
            initial={draftOf(kept.data.proxy)}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
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
  const queries = useQueryClient();
  const [draft, setDraft] = useState(initial);
  const save = useMutation({
    mutationFn: () =>
      call((api) =>
        api.sessions.setProxy({ params: { id: sessionId }, payload: { proxy: proxyOf(draft) } }),
      ),
    onSuccess: () => {
      toast.success("Routing changed");
      onDone();
    },
    onError: (error) => toastMutationError(error, "The routing was not changed"),
    onSettled: () => queries.invalidateQueries({ queryKey: queryKeys.proxy(sessionId) }),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };

  return (
    <form data-console-session-proxy onSubmit={submit} className="aperture:grid aperture:gap-4">
      <DialogHeader>
        <DialogTitle>Routing</DialogTitle>
        <DialogDescription>
          Where the session's browser connections go. It takes effect for new connections.
        </DialogDescription>
      </DialogHeader>
      <ProxyEditor draft={draft} onChange={setDraft} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}
